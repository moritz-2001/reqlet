// Verifies that RequestTarget displays the actual prepared destination and validation feedback without changing drafts.
import { mount, type VueWrapper } from "@vue/test-utils";
import { h, KeepAlive, nextTick, ref } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RequestTarget from "../src/components/RequestTarget.vue";
import { createRequest, type Environment } from "../src/request";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.useRealTimers();
});

it("shows the active environment and resolved URL including encoded query and authentication", () => {
  const request = {
    ...createRequest(), path: "{{baseUrl}}/users?key=old",
    query: [{ name: "search", value: "space here", enabled: true }],
    auth: { type: "api-key" as const, location: "query" as const, name: "key", value: "{{key}}" },
  };
  const environment: Environment = {
    id: "staging", name: "Staging", variables: [
      { name: "baseUrl", value: "https://staging.example.com", enabled: true },
      { name: "key", value: "example-key", enabled: true },
    ],
  };
  const original = structuredClone({ request, environment });
  const target = render({ request, environment });
  expect(target.text()).toContain("Environment: Staging");
  expect(target.get("code").text()).toBe("https://staging.example.com/users?search=space+here&key=example-key");
  expect(target.get(".destination").attributes("title")).toBe(target.get("code").text());
  expect({ request, environment }).toEqual(original);
});

it("reacts to changes of execution scope and displays missing variables before sending", async () => {
  const request = { ...createRequest(), path: "{{baseUrl}}/users" };
  const environment: Environment = {
    id: "local", name: "Local",
    variables: [{ name: "baseUrl", value: "http://localhost:8080", enabled: true }],
  };
  const target = render({ request, environment });
  expect(target.get("code").text()).toBe("http://localhost:8080/users");

  await target.setProps({ environment: { ...environment, name: "Production", variables: [
    { name: "baseUrl", value: "https://api.example.com", enabled: true },
  ] } });
  expect(target.text()).toContain("Environment: Production");
  expect(target.get("code").text()).toBe("https://api.example.com/users");

  await target.setProps({ environment: undefined });
  expect(target.text()).toContain("Environment: No environment");
  expect(target.get('[role="status"]').text()).toBe('Cannot send: Environment variable "baseUrl" is not defined.');
  expect(target.find("code").exists()).toBe(false);
});

it("reports validation in other request fields and recovers when the draft is corrected", async () => {
  const request = { ...createRequest(), path: "https://api.example.com", timeoutMs: 0 };
  const target = render({ request });
  expect(target.text()).toContain("Environment: No environment");
  expect(target.get('[role="status"]').text()).toContain("Timeout must be an integer");

  await target.setProps({ request: { ...request, timeoutMs: 30000 } });
  expect(target.find('[role="status"]').exists()).toBe(false);
  expect(target.get("code").text()).toBe("https://api.example.com/");
});

it("previews unchanged captured inputs without resolving literal placeholders against the active environment", async () => {
  const request = { ...createRequest(), path: "https://captured.example.com/action", body: "{{literal}}" };
  const environment: Environment = { id: "other", name: "Other environment", variables: [] };
  const target = render({ request, environment, capturedRequest: {
    method: "POST", url: request.path, body: request.body, headers: [], timeoutMs: 5000,
  } });

  expect(target.text()).toContain("Captured inputs");
  expect(target.text()).not.toContain("Other environment");
  expect(target.get("code").text()).toBe(request.path);
  expect(target.find('[role="status"]').exists()).toBe(false);

  await target.setProps({ capturedRequest: undefined });
  expect(target.text()).toContain("Environment: Other environment");
  expect(target.find('[role="status"]').exists()).toBe(false);
  await vi.advanceTimersByTimeAsync(200);
  expect(target.get('[role="status"]').text()).toContain('"literal" is not defined');
});

it("updates the destination immediately while validating template bodies after editing pauses", async () => {
  const request = { ...createRequest(), path: "https://api.example.com", body: '{"value":"{{missing}}"}' };
  const target = render({ request });
  expect(target.get("code").text()).toBe("https://api.example.com/");
  await vi.advanceTimersByTimeAsync(199);
  expect(target.find('[role="status"]').exists()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(target.get('[role="status"]').text()).toContain('"missing" is not defined');

  await target.setProps({ request: { ...request, path: "https://other.example.com", body: '{"value":"{{replacement}}"}' } });
  expect(target.get("code").text()).toBe("https://other.example.com/");
  expect(target.find('[role="status"]').exists()).toBe(false);
  await vi.advanceTimersByTimeAsync(200);
  expect(target.get('[role="status"]').text()).toContain('"replacement" is not defined');
  expect(target.text()).not.toContain('"missing"');
});

it("cancels pending body feedback when the request or its environment changes", async () => {
  const request = { ...createRequest(), path: "https://api.example.com", body: "{{missing}}" };
  const target = render({ request });
  await vi.advanceTimersByTimeAsync(100);
  await target.setProps({ request: { ...request, body: "{{available}}" } });
  await vi.advanceTimersByTimeAsync(100);
  expect(target.find('[role="status"]').exists()).toBe(false);
  await target.setProps({ environment: { id: "local", name: "Local", variables: [
    { name: "available", value: "value", enabled: true },
  ] } });
  await vi.advanceTimersByTimeAsync(200);
  expect(target.find('[role="status"]').exists()).toBe(false);
  expect(target.get("code").text()).toBe("https://api.example.com/");
});

it("replaces pending template validation with exact captured inputs", async () => {
  const request = { ...createRequest(), path: "https://api.example.com", body: "{{missing}}" };
  const target = render({ request });
  await vi.advanceTimersByTimeAsync(100);
  await target.setProps({ capturedRequest: {
    method: "POST", url: "https://captured.example.com/", body: "{{literal}}", headers: [], timeoutMs: 5000,
  } });
  await vi.advanceTimersByTimeAsync(200);
  expect(target.text()).toContain("Captured inputs");
  expect(target.get("code").text()).toBe("https://captured.example.com/");
  expect(target.find('[role="status"]').exists()).toBe(false);
});

it("restarts body feedback after a cached editor becomes active again", async () => {
  const visible = ref(true);
  const request = { ...createRequest(), path: "https://api.example.com", body: "{{missing}}" };
  const target = mount({
    setup: () => () => h(KeepAlive, null, () => visible.value ? h(RequestTarget, { request }) : null),
  });
  mounted.push(target);
  await vi.advanceTimersByTimeAsync(100);
  visible.value = false;
  await nextTick();
  await vi.advanceTimersByTimeAsync(200);

  visible.value = true;
  await nextTick();
  expect(target.find('[role="status"]').exists()).toBe(false);
  await vi.advanceTimersByTimeAsync(199);
  expect(target.find('[role="status"]').exists()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(target.get('[role="status"]').text()).toContain('"missing" is not defined');
});

it("labels literal inputs and ignores the selected environment even when its definitions are invalid", () => {
  const target = render({ request: { ...createRequest(), inputMode: "literal", path: "https://literal.test/{{token}}" },
    environment: { id: "bad", name: "Broken environment", variables: [
      { name: "token", value: "first", enabled: true }, { name: "token", value: "second", enabled: true },
    ] } });
  expect(target.text()).toContain("Literal inputs · Environment not applied");
  expect(target.text()).not.toContain("Broken environment");
  expect(target.get("code").text()).toBe("https://literal.test/%7B%7Btoken%7D%7D");
  expect(target.find('[role="status"]').exists()).toBe(false);
});

const mounted: VueWrapper[] = [];

function render(props: InstanceType<typeof RequestTarget>["$props"]) {
  const target = mount(RequestTarget, { props });
  mounted.push(target);
  return target;
}
