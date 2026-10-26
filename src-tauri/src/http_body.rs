// Bounds native response receipt and content decoding; DecodedBody retains the encoded byte count.
use async_compression::tokio::bufread::{BrotliDecoder, GzipDecoder, ZlibDecoder};
use reqwest::header;
use tokio::io::{AsyncRead, AsyncReadExt};

use super::{HttpFailure, failure, network_error};

/// Maximum encoded body or output of any content-decoding stage, including identity responses.
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
// Each layer retains its bounded input while producing bounded output. Limiting layers also bounds work.
const MAX_CONTENT_CODINGS: usize = 8;

/// Received response bytes after content decoding, ready for character-set conversion.
pub(super) struct DecodedBody {
    /// Content-decoded bytes, bounded separately from their compressed representation.
    pub(super) bytes: Vec<u8>,
    /// Actual encoded bytes received from reqwest; unaffected by content or character decoding.
    pub(super) received_size: usize,
}

/// Receives bounded chunks and reverses Content-Encoding without changing received headers.
pub(super) async fn receive_body(
    response: &mut reqwest::Response,
) -> Result<DecodedBody, HttpFailure> {
    // content_length() accounts for responses with no body, such as HEAD, unlike a raw header check.
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BODY_BYTES as u64)
    {
        return Err(body_limit("Received"));
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if chunk.len() > MAX_BODY_BYTES - bytes.len() {
            return Err(body_limit("Received"));
        }
        append_bounded(&mut bytes, &chunk);
    }
    let received_size = bytes.len();

    // Bodyless responses can describe a representation with any encoding; no decoder is needed.
    if !bytes.is_empty() {
        let codings = content_codings(response.headers())?;
        for coding in codings.iter().rev() {
            bytes = decode_content(&bytes, coding).await?;
        }
    }
    Ok(DecodedBody {
        bytes,
        received_size,
    })
}

fn content_codings(headers: &header::HeaderMap) -> Result<Vec<String>, HttpFailure> {
    let mut codings = Vec::new();
    for value in headers.get_all(header::CONTENT_ENCODING) {
        let value = value.to_str().map_err(|_| {
            failure(
                "network",
                "Response has an invalid Content-Encoding header.",
            )
        })?;
        for coding in value.split(',') {
            let coding = coding.trim().to_ascii_lowercase();
            if !matches!(
                coding.as_str(),
                "identity" | "gzip" | "x-gzip" | "deflate" | "br"
            ) {
                return Err(failure(
                    "network",
                    format!("Unsupported response Content-Encoding: {coding}."),
                ));
            }
            if coding != "identity" {
                if codings.len() == MAX_CONTENT_CODINGS {
                    return Err(failure(
                        "response-limit",
                        "Response exceeds the limit of 8 content encodings.",
                    ));
                }
                codings.push(coding);
            }
        }
    }
    Ok(codings)
}

async fn decode_content(bytes: &[u8], coding: &str) -> Result<Vec<u8>, HttpFailure> {
    let mut decoder: Box<dyn AsyncRead + Unpin + Send + '_> = match coding {
        "gzip" | "x-gzip" => {
            let mut decoder = GzipDecoder::new(bytes);
            decoder.multiple_members(true);
            Box::new(decoder)
        }
        // HTTP's deflate coding uses a zlib wrapper, rather than a raw DEFLATE stream.
        "deflate" => Box::new(ZlibDecoder::new(bytes)),
        "br" => Box::new(BrotliDecoder::new(bytes)),
        _ => unreachable!("content_codings validates supported non-identity codings"),
    };
    let mut decoded = Vec::new();
    // Keep scratch storage off the command future's stack when multiple sends are polled together.
    let mut chunk = vec![0; 64 * 1024];
    loop {
        // Read only bounded output at a time: a tiny compressed payload must never expand unchecked.
        let count = decoder.read(&mut chunk).await.map_err(|_| {
            failure(
                "network",
                format!("Could not decode the response's {coding} Content-Encoding."),
            )
        })?;
        if count == 0 {
            return Ok(decoded);
        }
        if count > MAX_BODY_BYTES - decoded.len() {
            return Err(body_limit("Decoded"));
        }
        append_bounded(&mut decoded, &chunk[..count]);
        // In-memory decoder reads can be immediately ready; yield so timeout and cancel still run.
        tokio::task::yield_now().await;
    }
}

fn body_limit(stage: &str) -> HttpFailure {
    failure(
        "response-limit",
        format!("{stage} response body exceeds the 64 MiB limit."),
    )
}

fn append_bounded(output: &mut Vec<u8>, chunk: &[u8]) {
    let needed = output.len() + chunk.len();
    if needed > output.capacity() {
        // Vec's default geometric growth can allocate beyond the limit for irregular network chunks.
        let capacity = needed.next_power_of_two().min(MAX_BODY_BYTES);
        output.reserve_exact(capacity - output.len());
    }
    output.extend_from_slice(chunk);
}

#[cfg(test)]
mod tests {
    use super::super::{HttpOperations, HttpRequest, execute};
    use super::*;
    use async_compression::tokio::bufread::{BrotliEncoder, GzipEncoder, ZlibEncoder};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[tokio::test]
    async fn gzip_is_decoded_before_charset_conversion_without_changing_headers_or_received_size() {
        let compressed = compress(b"caf\xe9", "gzip").await;
        let compressed_size = compressed.len();
        let url = serve(
            "Content-Type: text/plain; charset=iso-8859-1\r\nContent-Encoding: gzip\r\n",
            compressed,
            false,
        )
        .await;

        let response = send(&url).await.unwrap();
        assert_eq!(response.body, "café");
        assert_eq!(response.size_bytes, compressed_size);
        assert!(
            response
                .headers
                .iter()
                .any(|field| field.name == "content-encoding" && field.value == "gzip")
        );
        assert!(
            response
                .headers
                .iter()
                .any(|field| field.name == "content-length"
                    && field.value == compressed_size.to_string())
        );
    }

    #[tokio::test]
    async fn decodes_supported_codings_and_reverses_layered_encodings() {
        for coding in ["gzip", "deflate", "br"] {
            let body = compress(br#"{"ok":true}"#, coding).await;
            let url = serve(&format!("Content-Encoding: {coding}\r\n"), body, false).await;
            assert_eq!(send(&url).await.unwrap().body, r#"{"ok":true}"#);
        }

        let gzip = compress(b"layered", "gzip").await;
        let body = compress(&gzip, "br").await;
        let url = serve(
            "Content-Encoding: gzip\r\nContent-Encoding: br\r\n",
            body,
            false,
        )
        .await;
        assert_eq!(send(&url).await.unwrap().body, "layered");
    }

    #[tokio::test]
    async fn invalid_and_unsupported_content_codings_are_readable_errors() {
        for (coding, explanation) in [("gzip", "Could not decode"), ("unknown", "Unsupported")] {
            let url = serve(
                &format!("Content-Encoding: {coding}\r\n"),
                b"broken".to_vec(),
                false,
            )
            .await;
            let error = send(&url).await.unwrap_err();
            assert_eq!(error.kind, "network");
            assert!(error.message.contains(explanation));
        }
    }

    #[tokio::test]
    async fn compressed_expansion_is_stopped_at_the_decoded_limit() {
        let compressed = compress(&vec![b'a'; MAX_BODY_BYTES + 1], "gzip").await;
        assert!(compressed.len() < MAX_BODY_BYTES / 100);
        let url = serve("Content-Encoding: gzip\r\n", compressed, false).await;

        let error = send(&url).await.unwrap_err();
        assert_eq!(error.kind, "response-limit");
        assert!(error.message.starts_with("Decoded"));
        assert!(error.message.contains("64 MiB"));
    }

    #[tokio::test]
    async fn exactly_64_mib_is_accepted_for_chunked_receipt_and_decoded_output() {
        for coding in ["identity", "gzip"] {
            let body = vec![b'a'; MAX_BODY_BYTES];
            let body = if coding == "identity" {
                body
            } else {
                compress(&body, coding).await
            };
            let received_size = body.len();
            let url = serve(&format!("Content-Encoding: {coding}\r\n"), body, true).await;

            let response = send(&url).await.unwrap();
            assert_eq!(response.body.len(), 64 * 1024 * 1024);
            assert!(response.body.bytes().all(|byte| byte == b'a'));
            assert_eq!(response.size_bytes, received_size);
        }
    }

    #[tokio::test]
    async fn in_memory_expansion_yields_so_cancellation_can_interrupt_decoding() {
        let compressed = compress(&vec![b'a'; MAX_BODY_BYTES], "gzip").await;
        let cancellation = tokio_util::sync::CancellationToken::new();
        let decoding = async {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(failure("cancelled", "Request cancelled.")),
                result = decode_content(&compressed, "gzip") => result,
            }
        };
        let cancel = async {
            // Poll decoding first, then cancel from a competing task while it is expanding output.
            tokio::task::yield_now().await;
            cancellation.cancel();
        };

        let (result, _) = tokio::join!(biased; decoding, cancel);
        assert_eq!(result.unwrap_err().kind, "cancelled");
    }

    #[tokio::test]
    async fn chunked_uncompressed_receipt_is_stopped_without_content_length() {
        let url = serve("", vec![b'a'; MAX_BODY_BYTES + 1], true).await;

        let error = send(&url).await.unwrap_err();
        assert_eq!(error.kind, "response-limit");
        assert!(error.message.starts_with("Received"));
        assert!(error.message.contains("64 MiB"));
    }

    #[tokio::test]
    async fn announced_oversized_bodies_are_rejected_before_receiving_payload() {
        let url = serve(
            &format!("Content-Length: {}\r\n", MAX_BODY_BYTES + 1),
            Vec::new(),
            false,
        )
        .await;

        let error = send(&url).await.unwrap_err();
        assert_eq!(error.kind, "response-limit");
        assert!(error.message.starts_with("Received"));
    }

    #[tokio::test]
    async fn empty_bodies_can_describe_their_representation_encoding() {
        let url = serve("Content-Encoding: gzip\r\n", Vec::new(), false).await;
        let response = send(&url).await.unwrap();
        assert_eq!(response.body, "");
        assert_eq!(response.size_bytes, 0);
    }

    #[tokio::test]
    async fn head_can_describe_an_unsupported_encoding_and_oversized_representation_without_a_body()
    {
        let url = serve(
            &format!(
                "Content-Encoding: zstd\r\nContent-Length: {}\r\n",
                MAX_BODY_BYTES + 1
            ),
            Vec::new(),
            false,
        )
        .await;

        let response = send_method(&url, "HEAD").await.unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, "");
        assert_eq!(response.size_bytes, 0);
        assert!(
            response
                .headers
                .iter()
                .any(|field| field.name == "content-encoding" && field.value == "zstd")
        );
    }

    #[tokio::test]
    async fn not_modified_can_describe_an_unsupported_encoding_without_a_body() {
        let url = serve_status(
            "304 Not Modified",
            &format!(
                "Content-Encoding: zstd\r\nContent-Length: {}\r\n",
                MAX_BODY_BYTES + 1
            ),
            Vec::new(),
            false,
        )
        .await;

        let response = send(&url).await.unwrap();
        assert_eq!(response.status, 304);
        assert_eq!(response.body, "");
        assert_eq!(response.size_bytes, 0);
    }

    async fn send(url: &str) -> Result<super::super::HttpResponse, HttpFailure> {
        send_method(url, "GET").await
    }

    async fn send_method(
        url: &str,
        method: &str,
    ) -> Result<super::super::HttpResponse, HttpFailure> {
        let operations = HttpOperations::default();
        let id = operations.create().unwrap();
        let request = HttpRequest {
            method: method.into(),
            url: url.into(),
            headers: Vec::new(),
            body: String::new(),
            timeout_ms: 5000,
            redirect_policy: crate::http_redirects::RedirectPolicy::Never,
            sensitive_header_names: Vec::new(),
        };

        let result = execute(&operations, &id, request).await;
        assert!(operations.operations.lock().unwrap().is_empty());
        result
    }

    async fn compress(bytes: &[u8], coding: &str) -> Vec<u8> {
        let mut encoder: Box<dyn AsyncRead + Unpin + Send + '_> = match coding {
            "gzip" => Box::new(GzipEncoder::new(bytes)),
            "deflate" => Box::new(ZlibEncoder::new(bytes)),
            "br" => Box::new(BrotliEncoder::new(bytes)),
            _ => unreachable!(),
        };
        let mut encoded = Vec::new();
        encoder.read_to_end(&mut encoded).await.unwrap();
        encoded
    }

    async fn serve(headers: &str, body: Vec<u8>, chunked: bool) -> String {
        serve_status("200 OK", headers, body, chunked).await
    }

    async fn serve_status(status: &str, headers: &str, body: Vec<u8>, chunked: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let length_header = if chunked {
            "Transfer-Encoding: chunked\r\n".to_owned()
        } else if headers.contains("Content-Length:") {
            String::new()
        } else {
            format!("Content-Length: {}\r\n", body.len())
        };
        let prefix =
            format!("HTTP/1.1 {status}\r\n{headers}{length_header}Connection: close\r\n\r\n");
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let length = socket.read(&mut chunk).await.unwrap();
                if length == 0 {
                    return;
                }
                request.extend_from_slice(&chunk[..length]);
            }
            if socket.write_all(prefix.as_bytes()).await.is_err() {
                return;
            }
            if chunked
                && socket
                    .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                    .await
                    .is_err()
            {
                return;
            }
            // Exceeding the limit intentionally drops the connection before the fixture finishes.
            if socket.write_all(&body).await.is_err() {
                return;
            }
            if chunked {
                let _ = socket.write_all(b"\r\n0\r\n\r\n").await;
            }
        });
        url
    }
}
