// Copies concrete request snapshots so executions, history, and editable drafts own their nested storage.
import type { HttpRequest } from "./request";

/** Copies every mutable part of a transport snapshot, including credential forwarding metadata. */
export function copyHttpRequest(request: HttpRequest): HttpRequest {
  return {
    ...request,
    headers: request.headers.map(header => ({ ...header })),
    ...(request.sensitiveHeaderNames === undefined ? {} : { sensitiveHeaderNames: [...request.sensitiveHeaderNames] }),
  };
}
