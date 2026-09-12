import assert from "node:assert/strict";
import test from "node:test";
import type { Page, Response } from "@playwright/test";
import { navigateStaging } from "./browser-navigation.ts";

const url = "/?room=restore-pilot";
const response = { status: () => 200 } as Response;
const networkChanged = () => new Error("page.goto: net::ERR_NETWORK_CHANGED at https://localhost:8444/?room=restore-pilot");

function pageWith(outcomes: (Error | Response | null)[]) {
  const calls: string[] = [];
  return {
    calls,
    page: { goto: async (target: string) => {
      calls.push(target);
      const outcome = outcomes.shift();
      assert.notEqual(outcome, undefined, "navigation exceeded its attempt budget");
      if (outcome instanceof Error) throw outcome;
      return outcome!;
    } } satisfies Pick<Page, "goto">,
  };
}

test("staging navigation recovers from Chromium's transient network-change notification", async () => {
  const { page, calls } = pageWith([networkChanged(), response]);
  assert.equal(await navigateStaging(page, url), response);
  assert.deepEqual(calls, [url, url]);
});

test("staging navigation stops after three network-change failures", async () => {
  const last = networkChanged();
  const { page, calls } = pageWith([networkChanged(), networkChanged(), last]);
  await assert.rejects(navigateStaging(page, url), error => error === last);
  assert.equal(calls.length, 3);
});

for (const failure of ["ERR_CONNECTION_REFUSED", "ERR_CERT_AUTHORITY_INVALID", "ERR_ABORTED", "Timeout 30000ms exceeded"]) {
  test(`staging navigation does not retry ${failure}`, async () => {
    const error = new Error(`page.goto: ${failure}`);
    const { page, calls } = pageWith([error]);
    await assert.rejects(navigateStaging(page, url), actual => actual === error);
    assert.deepEqual(calls, [url]);
  });
}

test("staging navigation preserves HTTP errors for the caller's status assertion", async () => {
  const unavailable = { status: () => 503 } as Response;
  const { page, calls } = pageWith([unavailable]);
  assert.equal(await navigateStaging(page, url), unavailable);
  assert.deepEqual(calls, [url]);
});
