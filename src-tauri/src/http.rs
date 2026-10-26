// Runs native HTTP exchanges; HttpOperations shares connections and owns cancellation until each command finishes.
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use reqwest::{Client, Method, Url, header};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::http_redirects::{RedirectPolicy, send_with_redirects};

#[path = "http_body.rs"]
mod body;

/// Shares connection pooling while keeping cancellation and request settings local to each operation.
pub(super) struct HttpOperations {
    /// First execution loads TLS roots on a blocking worker; concurrent sends share the cached client or build failure.
    /// The shared slot outlives cancelled initialization waiters so later sends can reuse the completed build.
    client: Arc<OnceLock<Result<Client, String>>>,
    /// Tokens are inserted before execution, marked running once, and removed on completion.
    operations: Mutex<HashMap<String, Operation>>,
    /// Monotonic identities distinguish repeated sends even when they use the same saved request.
    next_id: AtomicU64,
}

impl Default for HttpOperations {
    fn default() -> Self {
        Self {
            client: Arc::new(OnceLock::new()),
            operations: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
        }
    }
}

impl HttpOperations {
    fn create(&self) -> Result<String, HttpFailure> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        self.operations.lock().map_err(registry_error)?.insert(
            id.clone(),
            Operation {
                cancellation: CancellationToken::new(),
                running: false,
            },
        );
        Ok(id)
    }

    fn start(&self, id: &str) -> Result<CancellationToken, HttpFailure> {
        let mut operations = self.operations.lock().map_err(registry_error)?;
        let operation = operations
            .get_mut(id)
            .ok_or_else(|| failure("internal", "HTTP operation no longer exists."))?;
        if operation.running {
            return Err(failure("internal", "HTTP operation has already started."));
        }
        operation.running = true;
        Ok(operation.cancellation.clone())
    }

    fn cancel(&self, id: &str) -> Result<(), HttpFailure> {
        if let Some(operation) = self.operations.lock().map_err(registry_error)?.get(id) {
            operation.cancellation.cancel();
        }
        Ok(())
    }

    async fn prepare_client(&self) -> Result<Client, HttpFailure> {
        let client = match self.client.get() {
            Some(client) => client.clone(),
            None => {
                let shared = Arc::clone(&self.client);
                tokio::task::spawn_blocking(move || {
                    shared
                        .get_or_init(|| {
                            // Every builder shares this pool, while redirects retain their explicit policy.
                            Client::builder()
                                .redirect(reqwest::redirect::Policy::none())
                                .build()
                                .map_err(|error| {
                                    format!(
                                        "HTTP client initialization failed: {}",
                                        error.without_url()
                                    )
                                })
                        })
                        .clone()
                })
                .await
                .map_err(|error| {
                    failure(
                        "internal",
                        format!("HTTP client initialization task failed: {error}"),
                    )
                })?
            }
        };
        client.map_err(|message| failure("network", message))
    }
}

/// Reserves cancellation before the frontend dispatches execution, preventing IPC ordering races.
#[tauri::command]
pub(super) fn http_create_operation(
    operations: tauri::State<'_, HttpOperations>,
) -> Result<String, HttpFailure> {
    operations.create()
}

/// Sends a concrete snapshot and returns HTTP statuses, including 4xx and 5xx, as responses.
#[tauri::command]
pub(super) async fn http_execute(
    operation_id: String,
    request: HttpRequest,
    operations: tauri::State<'_, HttpOperations>,
) -> Result<HttpResponse, HttpFailure> {
    execute(&operations, &operation_id, request).await
}

/// Cancels a reservation or a running operation; completion races are harmless no-ops.
#[tauri::command]
pub(super) fn http_cancel(
    operation_id: String,
    operations: tauri::State<'_, HttpOperations>,
) -> Result<(), HttpFailure> {
    operations.cancel(&operation_id)
}

/// Resolved request snapshot crossing the frontend/native boundary in camelCase.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HttpRequest {
    /// HTTP method token; validated again before the transport is constructed.
    method: String,
    /// Absolute HTTP(S) destination without URL-embedded credentials.
    url: String,
    /// Ordered enabled fields, retaining duplicate values for the same header name.
    headers: Vec<HttpHeader>,
    /// Exact UTF-8 request text; an empty value omits the body.
    body: String,
    /// Positive duration through complete body receipt, bounded by the browser timer maximum.
    timeout_ms: u64,
    /// Missing legacy values stop at the first redirect; following redirects is always opt-in.
    #[serde(default)]
    redirect_policy: RedirectPolicy,
    /// Additional credential field names removed after an origin change; absent legacy values add none.
    #[serde(default)]
    sensitive_header_names: Vec<String>,
}

/// Header entry shared by request snapshots and received response fields.
#[derive(Debug, Deserialize, Serialize)]
pub(super) struct HttpHeader {
    /// Protocol field name, matched case-insensitively by HTTP.
    name: String,
    /// Field value represented as Latin-1 text so non-ASCII wire bytes remain inspectable.
    value: String,
}

/// Completed exchange; response body bytes are decoded only after measuring their length.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HttpResponse {
    /// Final destination after redirects.
    url: String,
    /// Numeric protocol status, independent from transport success or failure.
    status: u16,
    /// Standard reason phrase, or empty when no canonical phrase exists.
    status_text: String,
    /// Received fields, retaining repeated values; original global wire order is unavailable.
    headers: Vec<HttpHeader>,
    /// Content-decoded body using its declared character set, with UTF-8 as the default.
    body: String,
    /// Elapsed milliseconds including connection, redirects, and complete body receipt.
    duration_ms: u64,
    /// Received encoded body length, before decompression and text conversion.
    size_bytes: usize,
}

/// Serializable error contract distinguishes cancellation, timeout, validation, and network errors.
#[derive(Debug, Serialize)]
pub(super) struct HttpFailure {
    /// Stable category interpreted by the frontend; cancellation becomes an AbortError.
    kind: &'static str,
    /// User-facing explanation with destination URLs stripped from network diagnostics.
    message: String,
}

async fn execute(
    operations: &HttpOperations,
    operation_id: &str,
    request: HttpRequest,
) -> Result<HttpResponse, HttpFailure> {
    let cancellation = operations.start(operation_id)?;
    let _cleanup = OperationCleanup {
        operations,
        operation_id,
    };
    if cancellation.is_cancelled() {
        return Err(failure("cancelled", "Request cancelled."));
    }

    let client = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(failure("cancelled", "Request cancelled.")),
        result = operations.prepare_client() => result?,
    };
    let prepared = prepare_request(&client, &request)?;
    let started_at = Instant::now();
    let exchange = async {
        let response = send_with_redirects(
            prepared,
            request.redirect_policy,
            &request.sensitive_header_names,
        )
        .await?;
        receive_response(response, started_at).await
    };
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(failure("cancelled", "Request cancelled.")),
        result = tokio::time::timeout(Duration::from_millis(request.timeout_ms), exchange) => {
            result.unwrap_or_else(|_| Err(failure("timeout", format!("Request timed out after {} ms.", request.timeout_ms))))
        }
    }
}

fn prepare_request(
    client: &Client,
    request: &HttpRequest,
) -> Result<reqwest::RequestBuilder, HttpFailure> {
    let url = Url::parse(&request.url)
        .map_err(|_| failure("validation", "Enter an absolute HTTP or HTTPS URL."))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(failure(
            "validation",
            "Use an HTTP or HTTPS URL without embedded credentials; configure authentication separately.",
        ));
    }
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| failure("validation", "Enter a valid HTTP method."))?;
    if request.timeout_ms == 0 || request.timeout_ms > 2_147_483_647 {
        return Err(failure(
            "validation",
            "Timeout must be an integer from 1 to 2147483647 milliseconds.",
        ));
    }

    let mut headers = header::HeaderMap::new();
    for field in &request.headers {
        let name = header::HeaderName::from_bytes(field.name.as_bytes())
            .map_err(|_| failure("validation", "Enter a valid HTTP header name."))?;
        let bytes: Option<Vec<u8>> = field
            .value
            .chars()
            .map(|character| u8::try_from(u32::from(character)).ok())
            .collect();
        let value = bytes
            .and_then(|bytes| header::HeaderValue::from_bytes(&bytes).ok())
            .ok_or_else(|| {
                failure(
                    "validation",
                    "Header values cannot contain line breaks or unsupported characters.",
                )
            })?;
        headers.append(name, value);
    }
    for name in &request.sensitive_header_names {
        header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| failure("validation", "Sensitive header names must be HTTP tokens."))?;
    }
    let mut prepared = client.request(method, url).headers(headers);
    if !request.body.is_empty() {
        prepared = prepared.body(request.body.clone());
    }
    Ok(prepared)
}

async fn receive_response(
    mut response: reqwest::Response,
    started_at: Instant,
) -> Result<HttpResponse, HttpFailure> {
    let url = response.url().to_string();
    let status = response.status();
    let encoding = response_encoding(response.headers());
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| HttpHeader {
            name: name.to_string(),
            value: value.as_bytes().iter().copied().map(char::from).collect(),
        })
        .collect();
    let received = body::receive_body(&mut response).await?;
    let (body, _, _) = encoding.decode(&received.bytes);

    Ok(HttpResponse {
        url,
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_owned(),
        headers,
        body: body.into_owned(),
        duration_ms: started_at
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
        size_bytes: received.received_size,
    })
}

fn response_encoding(headers: &header::HeaderMap) -> &'static encoding_rs::Encoding {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|content_type| {
            content_type.split(';').skip(1).find_map(|parameter| {
                let (name, value) = parameter.trim().split_once('=')?;
                name.trim()
                    .eq_ignore_ascii_case("charset")
                    .then(|| value.trim().trim_matches(['\'', '"']))
            })
        })
        .and_then(|charset| encoding_rs::Encoding::for_label(charset.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8)
}

pub(super) fn network_error(error: reqwest::Error) -> HttpFailure {
    let kind = if error.is_timeout() {
        "timeout"
    } else {
        "network"
    };
    failure(kind, format!("Request failed: {}", error.without_url()))
}

fn registry_error<T>(_: std::sync::PoisonError<T>) -> HttpFailure {
    failure("internal", "HTTP operation registry is unavailable.")
}

pub(super) fn failure(kind: &'static str, message: impl Into<String>) -> HttpFailure {
    HttpFailure {
        kind,
        message: message.into(),
    }
}

struct Operation {
    cancellation: CancellationToken,
    running: bool,
}

// RAII removes the registry entry even if the invoking future is dropped before completion.
struct OperationCleanup<'a> {
    operations: &'a HttpOperations,
    operation_id: &'a str,
}

impl Drop for OperationCleanup<'_> {
    fn drop(&mut self) {
        if let Ok(mut operations) = self.operations.operations.lock() {
            operations.remove(self.operation_id);
        }
    }
}

#[cfg(test)]
#[path = "http_client_tests.rs"]
mod client_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::oneshot,
    };

    #[tokio::test]
    async fn sends_snapshot_and_returns_http_errors_with_decoded_bytes_and_duplicate_headers() {
        let server = serve(b"HTTP/1.1 422 Unprocessable Entity\r\nContent-Type: text/plain; charset=iso-8859-1\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 4\r\nConnection: close\r\n\r\ncaf\xe9", Duration::ZERO).await;
        let mut request = request(&server.url);
        request.method = "POST".into();
        request.body = "{\"hello\":true}".into();
        request.headers.push(HttpHeader {
            name: "X-Example".into(),
            value: "one".into(),
        });
        request.headers.push(HttpHeader {
            name: "X-Example".into(),
            value: "two".into(),
        });
        let operations = HttpOperations::default();
        let id = operations.create().unwrap();

        let response = execute(&operations, &id, request).await.unwrap();
        assert_eq!(response.status, 422);
        assert_eq!(response.body, "café");
        assert_eq!(response.size_bytes, 4);
        assert_eq!(
            response
                .headers
                .iter()
                .filter(|header| header.name == "set-cookie")
                .count(),
            2
        );
        let wire_request = server.request.await.unwrap().to_ascii_lowercase();
        assert!(wire_request.starts_with("post /example?hello=world http/1.1\r\n"));
        assert!(wire_request.contains("x-example: one\r\nx-example: two\r\n"));
        assert!(wire_request.ends_with("{\"hello\":true}"));
        operations.cancel(&id).unwrap();
        assert!(operations.operations.lock().unwrap().is_empty());
        server.task.await.unwrap();
    }

    #[tokio::test]
    async fn timeout_includes_body_download_after_headers_arrive() {
        let server = serve(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            Duration::from_millis(150),
        )
        .await;
        let mut request = request(&server.url);
        request.timeout_ms = 25;
        let operations = HttpOperations::default();
        let id = operations.create().unwrap();

        let error = execute(&operations, &id, request).await.unwrap_err();
        assert_eq!(error.kind, "timeout");
        assert!(operations.operations.lock().unwrap().is_empty());
        server.task.abort();
    }

    #[tokio::test]
    async fn cancellation_interrupts_an_incomplete_body_and_releases_the_operation() {
        let server = serve(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            Duration::from_millis(500),
        )
        .await;
        let operations = HttpOperations::default();
        let id = operations.create().unwrap();
        let send = execute(&operations, &id, request(&server.url));
        let cancel = async {
            server.request.await.unwrap();
            operations.cancel(&id).unwrap();
        };

        let (result, _) = tokio::join!(send, cancel);
        assert_eq!(result.unwrap_err().kind, "cancelled");
        assert!(operations.operations.lock().unwrap().is_empty());
        server.task.abort();
    }

    #[tokio::test]
    async fn cancellation_before_execute_never_connects_and_cleans_up() {
        let operations = HttpOperations::default();
        let id = operations.create().unwrap();
        operations.cancel(&id).unwrap();

        let error = execute(&operations, &id, request("http://127.0.0.1:1"))
            .await
            .unwrap_err();
        assert_eq!(error.kind, "cancelled");
        assert!(operations.operations.lock().unwrap().is_empty());
        operations.cancel(&id).unwrap();
    }

    #[tokio::test]
    async fn rejects_untrusted_native_inputs_and_releases_reservations() {
        let invalid = [
            request("file:///tmp/example"),
            request("http://user:secret@localhost"),
            HttpRequest {
                method: "GET\r\nInjected".into(),
                ..request("http://localhost")
            },
            HttpRequest {
                timeout_ms: 0,
                ..request("http://localhost")
            },
            HttpRequest {
                timeout_ms: 2_147_483_648,
                ..request("http://localhost")
            },
            HttpRequest {
                headers: vec![HttpHeader {
                    name: "X-Test".into(),
                    value: "yes\r\nInjected: yes".into(),
                }],
                ..request("http://localhost")
            },
        ];
        let operations = HttpOperations::default();

        for request in invalid {
            let id = operations.create().unwrap();
            assert_eq!(
                execute(&operations, &id, request).await.unwrap_err().kind,
                "validation"
            );
            assert!(operations.operations.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn an_operation_cannot_be_executed_twice() {
        let operations = HttpOperations::default();
        let id = operations.create().unwrap();
        operations.start(&id).unwrap();
        assert_eq!(operations.start(&id).unwrap_err().kind, "internal");
    }

    #[test]
    fn legacy_snapshots_default_to_never_following_and_accept_additive_metadata() {
        let legacy = serde_json::json!({
            "method": "GET", "url": "https://example.com", "headers": [], "body": "", "timeoutMs": 1000,
        });
        let decoded: HttpRequest = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(decoded.redirect_policy, RedirectPolicy::Never);
        assert!(decoded.sensitive_header_names.is_empty());

        let mut current = legacy;
        current["redirectPolicy"] = serde_json::json!("same-origin");
        current["sensitiveHeaderNames"] = serde_json::json!(["X-Key"]);
        let decoded: HttpRequest = serde_json::from_value(current).unwrap();
        assert_eq!(decoded.redirect_policy, RedirectPolicy::SameOrigin);
        assert_eq!(decoded.sensitive_header_names, ["X-Key"]);
    }

    fn request(url: &str) -> HttpRequest {
        HttpRequest {
            method: "GET".into(),
            url: url.into(),
            headers: Vec::new(),
            body: String::new(),
            timeout_ms: 2000,
            redirect_policy: RedirectPolicy::Never,
            sensitive_header_names: Vec::new(),
        }
    }

    struct LocalServer {
        url: String,
        request: oneshot::Receiver<String>,
        task: tokio::task::JoinHandle<()>,
    }

    async fn serve(response: &'static [u8], body_delay: Duration) -> LocalServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/example?hello=world",
            listener.local_addr().unwrap()
        );
        let (sender, request) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let mut chunk = [0; 1024];
            loop {
                let count = stream.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                received.extend_from_slice(&chunk[..count]);
                if let Some(end) = received.windows(4).position(|window| window == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&received[..end]).to_ascii_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length: ")
                                .and_then(|length| length.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if received.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let _ = sender.send(String::from_utf8_lossy(&received).into_owned());
            let body_at = response
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .unwrap()
                + 4;
            stream.write_all(&response[..body_at]).await.unwrap();
            tokio::time::sleep(body_delay).await;
            let _ = stream.write_all(&response[body_at..]).await;
        });
        LocalServer { url, request, task }
    }
}
