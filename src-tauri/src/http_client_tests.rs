// Verifies HttpOperations connection sharing through observable requests on a persistent local HTTP server.
use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::{JoinHandle, JoinSet},
};

#[tokio::test]
async fn consecutive_operations_reuse_connections_without_reusing_request_settings() {
    let mut server = serve().await;
    let operations = HttpOperations::default();
    let mut first = request(&server.url, "/first");
    first.method = "POST".into();
    first.body = "first body".into();
    first.headers = vec![
        field("Authorization", "Bearer first"),
        field("Cookie", "explicit=first"),
        field("X-Only-First", "first"),
    ];

    execute(&operations, &operations.create().unwrap(), first)
        .await
        .unwrap();
    let mut second = request(&server.url, "/slow");
    second.headers = vec![
        field("Authorization", "Bearer second"),
        field("X-Only-Second", "second"),
    ];
    execute(&operations, &operations.create().unwrap(), second)
        .await
        .unwrap();
    execute(
        &operations,
        &operations.create().unwrap(),
        request(&server.url, "/third"),
    )
    .await
    .unwrap();

    let first = server.requests.recv().await.unwrap();
    let second = server.requests.recv().await.unwrap();
    let third = server.requests.recv().await.unwrap();
    assert_eq!(first.connection, second.connection);
    assert_eq!(second.connection, third.connection);
    assert!(first.wire.starts_with("post /first "));
    assert!(first.wire.contains("authorization: bearer first\r\n"));
    assert!(first.wire.contains("cookie: explicit=first\r\n"));
    assert!(first.wire.ends_with("first body"));
    assert!(second.wire.starts_with("get /slow "));
    assert!(second.wire.contains("authorization: bearer second\r\n"));
    assert!(second.wire.contains("x-only-second: second\r\n"));
    for wire in [&second.wire, &third.wire] {
        assert!(
            !wire.contains("cookie:"),
            "cookie state leaked between sends"
        );
        assert!(!wire.contains("x-only-first:"));
        assert!(!wire.contains("first body"));
    }
    assert!(!third.wire.contains("authorization:"));
    assert!(!third.wire.contains("x-only-second:"));
}

#[tokio::test]
async fn a_timeout_does_not_shorten_a_later_operation_on_the_shared_client() {
    let mut server = serve().await;
    let operations = HttpOperations::default();
    let mut short = request(&server.url, "/pending");
    short.timeout_ms = 25;

    let error = execute(&operations, &operations.create().unwrap(), short)
        .await
        .unwrap_err();
    assert_eq!(error.kind, "timeout");
    let response = execute(
        &operations,
        &operations.create().unwrap(),
        request(&server.url, "/slow"),
    )
    .await
    .unwrap();

    assert_eq!(response.body, "ok");
    assert!(
        server
            .requests
            .recv()
            .await
            .unwrap()
            .wire
            .starts_with("get /pending ")
    );
    assert!(
        server
            .requests
            .recv()
            .await
            .unwrap()
            .wire
            .starts_with("get /slow ")
    );
    assert!(operations.operations.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancelling_one_operation_preserves_another_using_the_same_client() {
    let mut server = serve().await;
    let operations = HttpOperations::default();
    let cancelled_id = operations.create().unwrap();
    let completing_id = operations.create().unwrap();
    let sends = async {
        tokio::join!(
            execute(&operations, &cancelled_id, request(&server.url, "/pending")),
            execute(&operations, &completing_id, request(&server.url, "/slow")),
        )
    };
    let cancel = async {
        // Both requests must be on the wire before cancellation tests their independent lifetimes.
        server.requests.recv().await.unwrap();
        server.requests.recv().await.unwrap();
        operations.cancel(&cancelled_id).unwrap();
    };

    let ((cancelled, completed), ()) = tokio::join!(sends, cancel);

    assert_eq!(cancelled.unwrap_err().kind, "cancelled");
    assert_eq!(completed.unwrap().body, "ok");
    assert!(operations.operations.lock().unwrap().is_empty());
}

#[tokio::test]
async fn client_initialization_failure_uses_normal_execution_error_cleanup() {
    let operations = HttpOperations {
        client: Arc::new(OnceLock::from(Err(
            "HTTP client initialization failed: unavailable TLS configuration".into(),
        ))),
        operations: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(0),
    };
    let operation_id = operations.create().unwrap();

    let error = execute(
        &operations,
        &operation_id,
        request("http://127.0.0.1:1", "/"),
    )
    .await
    .unwrap_err();

    assert_eq!(error.kind, "network");
    assert!(error.message.contains("HTTP client initialization failed:"));
    assert!(operations.operations.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancellation_during_client_initialization_does_not_wait_for_tls_loading() {
    let operations = HttpOperations::default();
    let client = Arc::clone(&operations.client);
    let (started, ready) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    let initializer = std::thread::spawn(move || {
        client.get_or_init(|| {
            started.send(()).unwrap();
            // Bound this fixture even if an assertion fails before releasing initialization.
            resume.recv_timeout(Duration::from_secs(2)).unwrap();
            Err("HTTP client initialization failed: test fixture".into())
        });
    });
    ready.recv_timeout(Duration::from_secs(2)).unwrap();
    let operation_id = operations.create().unwrap();
    let started_at = Instant::now();
    let send = execute(
        &operations,
        &operation_id,
        request("http://127.0.0.1:1", "/"),
    );
    let cancel = async {
        tokio::task::yield_now().await;
        operations.cancel(&operation_id).unwrap();
    };

    let (result, ()) = tokio::join!(send, cancel);
    let elapsed = started_at.elapsed();
    release.send(()).unwrap();
    initializer.join().unwrap();

    assert_eq!(result.unwrap_err().kind, "cancelled");
    assert!(elapsed < Duration::from_secs(1));
    assert!(operations.operations.lock().unwrap().is_empty());
}

fn request(origin: &str, path: &str) -> HttpRequest {
    HttpRequest {
        method: "GET".into(),
        url: format!("{origin}{path}"),
        headers: Vec::new(),
        body: String::new(),
        timeout_ms: 2000,
        redirect_policy: RedirectPolicy::Never,
        sensitive_header_names: Vec::new(),
    }
}

fn field(name: &str, value: &str) -> HttpHeader {
    HttpHeader {
        name: name.into(),
        value: value.into(),
    }
}

struct ObservedRequest {
    connection: usize,
    wire: String,
}

struct Server {
    url: String,
    requests: mpsc::UnboundedReceiver<ObservedRequest>,
    task: JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn serve() -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (sender, requests) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        // Dropping this set also aborts any connections still serving an intentionally delayed body.
        let mut connections = JoinSet::new();
        let mut next_connection = 0;
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (stream, _) = accepted.unwrap();
                    connections.spawn(serve_connection(stream, next_connection, sender.clone()));
                    next_connection += 1;
                }
                Some(result) = connections.join_next(), if !connections.is_empty() => result.unwrap(),
            }
        }
    });
    Server {
        url,
        requests,
        task,
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    connection: usize,
    sender: mpsc::UnboundedSender<ObservedRequest>,
) {
    while let Some(wire) = read_request(&mut stream).await {
        let delay = if wire.starts_with("get /pending ") {
            Duration::from_secs(5)
        } else if wire.starts_with("get /slow ") {
            Duration::from_millis(150)
        } else {
            Duration::ZERO
        };
        sender.send(ObservedRequest { connection, wire }).unwrap();
        let headers = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: received=must-not-be-shared\r\n\r\n";
        if stream.write_all(headers).await.is_err() {
            break;
        }
        tokio::time::sleep(delay).await;
        if stream.write_all(b"ok").await.is_err() {
            break;
        }
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<String> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    loop {
        let count = stream.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
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
                return Some(String::from_utf8_lossy(&bytes).to_ascii_lowercase());
            }
        }
    }
}
