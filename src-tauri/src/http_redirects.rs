// Inspects every redirect before transmission; RedirectPolicy controls destinations and credential retention.
use reqwest::{Method, Request, Response, StatusCode, Url, header};
use serde::Deserialize;

use crate::http::{HttpFailure, failure, network_error};

/// Destination policy captured in a request snapshot; omitted legacy values stop at the first redirect.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum RedirectPolicy {
    /// Return the first response, including its redirect status and body.
    #[default]
    Never,
    /// Follow only when scheme, hostname, and effective port remain unchanged.
    SameOrigin,
    /// Follow other origins while permanently removing known credentials and forbidding HTTPS downgrades.
    Follow,
}

/// Sends at most eleven requests under the caller's cancellation and whole-exchange timeout.
pub(super) async fn send_with_redirects(
    builder: reqwest::RequestBuilder,
    policy: RedirectPolicy,
    sensitive_header_names: &[String],
) -> Result<Response, HttpFailure> {
    let (client, request) = builder.build_split();
    let mut request = request.map_err(network_error)?;
    for redirects in 0..=10 {
        let outgoing = request.try_clone().ok_or_else(|| {
            failure(
                "internal",
                "The request body cannot be replayed for a redirect.",
            )
        })?;
        let response = client.execute(outgoing).await.map_err(network_error)?;
        if policy == RedirectPolicy::Never || !is_redirect(response.status()) {
            return Ok(response);
        }
        let Some(location) = response.headers().get(header::LOCATION) else {
            return Ok(response);
        };
        let destination = location
            .to_str()
            .ok()
            .and_then(|location| response.url().join(location).ok())
            .ok_or_else(|| {
                failure(
                    "network",
                    "The server returned an invalid redirect destination.",
                )
            })?;
        let same_origin = same_origin(request.url(), &destination);
        if policy == RedirectPolicy::SameOrigin && !same_origin {
            return Ok(response);
        }
        validate_destination(request.url(), &destination)?;
        if redirects == 10 {
            return Err(failure(
                "network",
                "The request exceeded the limit of 10 redirects.",
            ));
        }

        prepare_redirect(
            &mut request,
            response.status(),
            destination,
            same_origin,
            sensitive_header_names,
        );
    }
    unreachable!("the redirect limit always returns a response or an error")
}

fn prepare_redirect(
    request: &mut Request,
    status: StatusCode,
    destination: Url,
    same_origin: bool,
    sensitive_header_names: &[String],
) {
    if !same_origin {
        // Removal persists in the replay snapshot, even if a later redirect returns to the original origin.
        for name in [
            "authorization",
            "cookie",
            "cookie2",
            "proxy-authorization",
            "www-authenticate",
            "host",
        ] {
            request.headers_mut().remove(name);
        }
        for name in sensitive_header_names {
            request.headers_mut().remove(name.as_str());
        }
    }
    if (status == StatusCode::SEE_OTHER && request.method() != Method::HEAD)
        || (matches!(status, StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND)
            && request.method() == Method::POST)
    {
        *request.method_mut() = Method::GET;
        *request.body_mut() = None;
        for name in [
            header::CONTENT_LENGTH,
            header::CONTENT_TYPE,
            header::CONTENT_ENCODING,
            header::TRANSFER_ENCODING,
        ] {
            request.headers_mut().remove(name);
        }
    }
    *request.url_mut() = destination;
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn validate_destination(source: &Url, destination: &Url) -> Result<(), HttpFailure> {
    if !matches!(destination.scheme(), "http" | "https")
        || destination.host_str().is_none()
        || !destination.username().is_empty()
        || destination.password().is_some()
    {
        return Err(failure(
            "network",
            "Redirects require an HTTP(S) destination without embedded credentials.",
        ));
    }
    if source.scheme() == "https" && destination.scheme() == "http" {
        return Err(failure(
            "network",
            "An HTTPS to HTTP redirect was blocked to protect request credentials and data.",
        ));
    }
    Ok(())
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::mpsc,
    };

    #[tokio::test]
    async fn default_policy_returns_redirect_without_contacting_another_origin() {
        let mut target = serve(|_| vec![ok()]).await;
        let mut source = serve(|_| vec![redirect(&target.url, 302)]).await;

        let response = send(&source.url, RedirectPolicy::Never, &[]).await.unwrap();
        assert_eq!(response.status(), 302);
        assert!(
            source
                .requests
                .recv()
                .await
                .unwrap()
                .contains("x-api-key: secret")
        );
        assert!(target.requests.try_recv().is_err());
        target.task.abort();
    }

    #[tokio::test]
    async fn same_origin_follows_with_credentials_but_stops_before_a_different_port() {
        let mut target = serve(|_| vec![ok()]).await;
        let mut source = serve(|_| vec![redirect("/next", 302), redirect(&target.url, 302)]).await;

        let response = send(&source.url, RedirectPolicy::SameOrigin, &[])
            .await
            .unwrap();
        assert_eq!(response.status(), 302);
        assert!(
            source
                .requests
                .recv()
                .await
                .unwrap()
                .contains("x-api-key: secret")
        );
        assert!(
            source
                .requests
                .recv()
                .await
                .unwrap()
                .contains("x-api-key: secret")
        );
        assert!(target.requests.try_recv().is_err());
        target.task.abort();
    }

    #[tokio::test]
    async fn follow_removes_all_credentials_permanently_after_an_origin_change() {
        let source_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let original_url = format!("http://{}/start", source_listener.local_addr().unwrap());
        let mut target = serve(|_| vec![redirect(&original_url, 302)]).await;
        let (sender, mut source_requests) = mpsc::unbounded_channel();
        let target_url = target.url.clone();
        let source_task = tokio::spawn(async move {
            for response in [redirect(&target_url, 302), ok()] {
                let (mut stream, _) = source_listener.accept().await.unwrap();
                sender.send(read_request(&mut stream).await).unwrap();
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let response = send(&original_url, RedirectPolicy::Follow, &["x-api-key".into()])
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let first = source_requests.recv().await.unwrap();
        assert!(first.contains("x-api-key: secret"));
        assert!(first.contains("authorization: bearer secret"));
        for wire in [
            target.requests.recv().await.unwrap(),
            source_requests.recv().await.unwrap(),
        ] {
            for field in [
                "x-api-key:",
                "authorization:",
                "cookie:",
                "cookie2:",
                "proxy-authorization:",
                "www-authenticate:",
            ] {
                assert!(!wire.contains(field), "credential field leaked: {field}");
            }
            assert!(wire.contains("x-public: visible"));
        }
        source_task.await.unwrap();
    }

    #[tokio::test]
    async fn redirect_loops_fail_after_ten_hops() {
        let mut source = serve(|_| (0..11).map(|_| redirect("/loop", 302)).collect()).await;

        let error = send(&source.url, RedirectPolicy::Follow, &[])
            .await
            .unwrap_err();
        assert!(format!("{error:?}").contains("10 redirects"));
        let mut sent = 0;
        while source.requests.recv().await.is_some() {
            sent += 1;
        }
        assert_eq!(sent, 11);
    }

    #[tokio::test]
    async fn redirect_statuses_apply_the_documented_method_and_body_rules() {
        for (status, preserved) in [
            (301, false),
            (302, false),
            (303, false),
            (307, true),
            (308, true),
        ] {
            let mut source = serve(|_| vec![redirect("/next", status), ok()]).await;
            let builder = client()
                .post(&source.url)
                .header("content-type", "text/plain")
                .body("payload");

            let response = send_with_redirects(builder, RedirectPolicy::SameOrigin, &[])
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            source.requests.recv().await.unwrap();
            let next = source.requests.recv().await.unwrap();
            assert!(next.starts_with(if preserved {
                "post /next "
            } else {
                "get /next "
            }));
            assert_eq!(next.contains("content-type: text/plain"), preserved);
            assert_eq!(next.ends_with("payload"), preserved);
        }
    }

    #[test]
    fn origin_checks_include_scheme_and_port_and_downgrades_are_rejected() {
        let https = Url::parse("https://example.com/a").unwrap();
        assert!(same_origin(
            &https,
            &Url::parse("https://EXAMPLE.com:443/b").unwrap()
        ));
        assert!(!same_origin(
            &https,
            &Url::parse("https://example.com:444/b").unwrap()
        ));
        let http = Url::parse("http://example.com/a").unwrap();
        assert!(!same_origin(&https, &http));
        assert!(validate_destination(&https, &http).is_err());
        assert!(validate_destination(&http, &https).is_ok());
        assert!(
            validate_destination(
                &https,
                &Url::parse("https://user:secret@example.com").unwrap()
            )
            .is_err()
        );
    }

    async fn send(
        url: &str,
        policy: RedirectPolicy,
        names: &[String],
    ) -> Result<Response, HttpFailure> {
        let builder = client()
            .get(url)
            .header("X-Api-Key", "secret")
            .header("Authorization", "Bearer secret")
            .header("Cookie", "session=secret")
            .header("Cookie2", "session=secret")
            .header("Proxy-Authorization", "Basic secret")
            .header("WWW-Authenticate", "secret")
            .header("X-Public", "visible");
        send_with_redirects(builder, policy, names).await
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    fn redirect(location: &str, status: u16) -> String {
        format!(
            "HTTP/1.1 {status} Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    }

    fn ok() -> String {
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".into()
    }

    struct Server {
        url: String,
        requests: mpsc::UnboundedReceiver<String>,
        task: tokio::task::JoinHandle<()>,
    }

    async fn serve(responses: impl FnOnce(&str) -> Vec<String>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/start", listener.local_addr().unwrap());
        let responses = responses(&url);
        let (sender, requests) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            for response in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let _ = sender.send(read_request(&mut stream).await);
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        Server {
            url,
            requests,
            task,
        }
    }

    async fn read_request(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut chunk = [0; 1024];
        loop {
            let count = stream.read(&mut chunk).await.unwrap();
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length: ")
                            .and_then(|value| value.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&bytes).to_ascii_lowercase()
    }
}
