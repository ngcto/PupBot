import { describe, expect, it } from "vitest";
import {
  assessChallenge,
  createSolver,
  detectCaptcha,
  describeDetection,
  findTools,
  solverConfigFromEnv,
  solverRequestFor,
  tokenInjectionScript,
  type CaptchaSolver,
  type CuaPageState,
} from "../src/index.ts";

function page(overrides: Partial<CuaPageState> = {}): CuaPageState {
  return {
    url: "https://app.example.com/login",
    title: "Sign in",
    outline: "- heading \"Sign in\"\n  - textbox \"Email\"",
    refs: [],
    content: [],
    snapshotId: "p1",
    truncated: false,
    durationMs: 5,
    ...overrides,
  };
}

describe("detection", () => {
  it("names a reCAPTCHA v2 checkbox and lifts its public site key", () => {
    const detection = detectCaptcha({
      frameUrls: [
        "https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Lc_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345&co=aHR0cHM6",
      ],
    });
    expect(detection.gated).toBe(true);
    expect(detection.primary?.kind).toBe("recaptcha_v2_checkbox");
    expect(detection.primary?.siteKey).toBe("6Lc_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345");
    // A site key is public — it ships in the page's own HTML — so a solver can use it.
    expect(detection.solvable).toBe(true);
  });

  it("prefers the site key the widget actually uses over one scraped from a frame URL", () => {
    const detection = detectCaptcha({
      frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=6Lc_fromTheFrame00000000000"],
      html: '<div class="g-recaptcha" data-sitekey="6Lc_theAttribute0000000000"></div>',
    });
    expect(detection.primary?.siteKey).toBe("6Lc_theAttribute0000000000");
  });

  it("recognises Turnstile and hCaptcha when the widget is rendered", () => {
    const turnstile = detectCaptcha({
      frameUrls: ["https://challenges.cloudflare.com/turnstile/v0/bframe?sitekey=0x4AAAA"],
    });
    expect(turnstile.primary?.kind).toBe("turnstile");
    expect(turnstile.gated).toBe(true);

    const hcaptcha = detectCaptcha({
      frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html"],
      html: '<textarea id="h-captcha-response"></textarea>',
    });
    expect(hcaptcha.primary?.kind).toBe("hcaptcha");
    expect(hcaptcha.gated).toBe(true);
  });

  it("names a loaded widget library without calling the page gated", () => {
    // Same hosts, no rendered challenge: advisory, never `primary`.
    const turnstile = detectCaptcha({ frameUrls: ["https://challenges.cloudflare.com/turnstile/v0/api.js"] });
    expect(turnstile.signals[0]?.kind).toBe("turnstile");
    expect(turnstile.signals[0]?.advisory).toBe(true);
    expect(turnstile.primary).toBeUndefined();
    expect(turnstile.gated).toBe(false);

    const hcaptcha = detectCaptcha({ frameUrls: ["https://hcaptcha.com/1/api.js"] });
    expect(hcaptcha.signals[0]?.kind).toBe("hcaptcha");
    expect(hcaptcha.primary).toBeUndefined();
    expect(hcaptcha.gated).toBe(false);
  });

  it("recognises a Cloudflare interstitial as a soft gate that a human cadence may clear", () => {
    const detection = detectCaptcha({ title: "Just a moment...", text: "Checking your browser before accessing" });
    expect(detection.primary?.kind).toBe("cloudflare_interstitial");
    expect(detection.primary?.soft).toBe(true);
    // No site key means no token to inject, so it is not solvable by a solver.
    expect(detection.solvable).toBe(false);
  });

  it("falls back to an unnamed challenge when a challenge frame is present", () => {
    const detection = detectCaptcha({
      title: "Security check",
      frameUrls: ["https://verify.example.com/challenge/main"],
    });
    expect(detection.primary?.kind).toBe("unknown_challenge");
    expect(detection.primary?.confidence).toBe("medium");
    expect(detection.gated).toBe(true);
  });

  it("does not call a page gated on its title alone", () => {
    // "Security check" as a title with nothing behind it is a hint; treating it
    // as a gate would tell a model to solve a challenge that is not there.
    const detection = detectCaptcha({ title: "Security check", frameUrls: [] });
    expect(detection.primary).toBeUndefined();
    expect(detection.gated).toBe(false);
    expect(detection.signals[0]?.advisory).toBe(true);
  });

  it("keeps a host on the authority instead of matching it anywhere", () => {
    // A host name in a query string or a look-alike domain is not that host.
    // Matching either one reports a clean page as a challenge, which is the
    // worst thing this module can do.
    const smuggled = detectCaptcha({
      frameUrls: ["https://evil.example/?next=https://hcaptcha.com/captcha/v1/abc"],
    });
    expect(smuggled.gated).toBe(false);
    expect(smuggled.signals).toEqual([]);

    // A subdomain of someone else's domain that merely *starts with* the real
    // host is not that host.
    const lookAlike = detectCaptcha({
      frameUrls: ["https://hcaptcha.com.attacker.example/assets/widget.js"],
    });
    expect(lookAlike.gated).toBe(false);
    expect(lookAlike.signals).toEqual([]);

    // The real host, and its real subdomain, still match.
    expect(detectCaptcha({ frameUrls: ["https://hcaptcha.com/captcha"] }).gated).toBe(true);
    expect(
      detectCaptcha({ frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/abc"] }).gated,
    ).toBe(true);
  });

  it("says a clean page is clean", () => {
    const detection = detectCaptcha({ frameUrls: ["https://app.example.com/#main"], title: "Dashboard", text: "Hello" });
    expect(detection.gated).toBe(false);
    expect(detection.signals).toEqual([]);
    expect(describeDetection(detection)).toContain("not gated");
  });

  it("describes the gate in one sentence a model can act on", () => {
    const detection = detectCaptcha({
      frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html"],
      html: '<div data-sitekey="10000000-ffff-ffff-ffff-000000000001"></div><textarea id="h-captcha-response"></textarea>',
    });
    expect(detection.gated).toBe(true);
    const text = describeDetection(detection);
    expect(text).toContain("hcaptcha");
    expect(text).toContain("token");
  });
});

describe("the challenge ladder", () => {
  const gatedPage = page({
    refs: [
      {
        ref: "p1:4",
        role: "iframe",
        name: "reCAPTCHA",
        value: null,
        actions: [],
        frame: "https://www.google.com/recaptcha/api2/anchor?k=6Lc_siteKeyHere000000000000",
      },
    ],
  });

  const configuredSolver: CaptchaSolver = {
    provider: "2captcha",
    configured: true,
    async solve() {
      return { ok: true, token: "solved-token-value", provider: "2captcha", waitedSeconds: 12 };
    },
  };

  /** A page with a challenge frame: a real gate, unlike a title alone. */
  const humanPage = page({
    title: "Are you a robot?",
    refs: [
      { ref: "p1:1", role: "iframe", name: "Challenge", value: null, actions: [], frame: "https://verify.example.com/challenge" },
    ],
  });

  it("puts the existing session first, because not losing the cookie is the cheapest rung", async () => {
    const assessment = await assessChallenge(gatedPage, { persistentProfile: true, solver: configuredSolver });
    expect(assessment.next).toBe("existing_session");
    expect(assessment.paths[0]).toBe("existing_session");
    // Planning does not spend a solver round trip.
    expect(assessment.injectScript).toBeUndefined();
    expect(assessment.passed).toBe(false);
  });

  it("offers a different entry as advice rather than pretending it is a page mechanism", async () => {
    const assessment = await assessChallenge(gatedPage, {});
    // Nothing on this page can pass it: no saved session, no soft heuristic, no
    // solver. The honest answer is "try the API or ask a person", not a fake rung.
    expect(assessment.paths).toEqual([]);
    expect(assessment.next).toBe("different_entry");
    expect(assessment.differentEntryAvailable).toBe(true);
    expect(assessment.needsHuman).toBeUndefined();
  });

  it("prefers a slow retry over a solver when the gate is a soft heuristic", async () => {
    const soft = page({ title: "Just a moment...", refs: [] });
    const assessment = await assessChallenge(soft, { solver: configuredSolver });
    expect(assessment.next).toBe("slow_retry");
    expect(assessment.retryAdvice?.attempts).toBe(2);
    // A holding page has no site key, so a solver has nothing to work with.
    expect(assessment.detection.solvable).toBe(false);
    expect(assessment.paths).toEqual(["slow_retry"]);
  });

  it("makes the named widget outrank an interstitial hint, because the widget is what gates the page", async () => {
    const softKeyed = page({
      title: "Just a moment...",
      refs: [
        {
          ref: "p1:2",
          role: "iframe",
          name: "Verification",
          value: null,
          actions: [],
          frame: "https://challenges.cloudflare.com/turnstile/v0/bframe?k=0x4AAAAAAA_siteKey",
        },
      ],
    });
    const assessment = await assessChallenge(softKeyed, { solver: configuredSolver });
    // The interstitial marker is present, but the Turnstile widget is the real
    // gate and it has a site key, so the solver rung is the precise answer.
    expect(assessment.detection.signals[0]?.kind).toBe("turnstile");
    expect(assessment.detection.primary?.kind).toBe("turnstile");
    expect(assessment.paths).toEqual(["solver"]);
    expect(assessment.detection.solvable).toBe(true);
  });

  it("asks the solver when told to solve, and returns an injection script", async () => {
    const assessment = await assessChallenge(gatedPage, {
      solver: configuredSolver,
      pageUrl: "https://app.example.com/login",
      solve: true,
    });
    expect(assessment.solverOutcome?.ok).toBe(true);
    expect(assessment.injectScript).toContain("g-recaptcha-response");
    // The token is installed by the caller in the page; this call did not
    // re-read the page, so the gate is not yet proven cleared.
    expect(assessment.passed).toBe(false);
  });

  it("reports the solver's failure honestly instead of pretending the page opened", async () => {
    const failing: CaptchaSolver = {
      provider: "2captcha",
      configured: true,
      async solve() {
        return { ok: false, reason: "timeout", message: "the solver did not return a token within 180s" };
      },
    };
    const assessment = await assessChallenge(gatedPage, {
      solver: failing,
      pageUrl: "https://app.example.com/login",
      solve: true,
    });
    expect(assessment.solverOutcome?.ok).toBe(false);
    expect(assessment.injectScript).toBeUndefined();
    expect(assessment.passed).toBe(false);
  });

  it("says no solver is configured rather than silently doing nothing", async () => {
    const assessment = await assessChallenge(gatedPage, { solve: true, pageUrl: "https://app.example.com" });
    // The page IS solvable; this deployment just has no solver, so it is not a
    // rung and no token is attempted.
    expect(assessment.detection.solvable).toBe(true);
    expect(assessment.solverOutcome).toBeUndefined();
    expect(assessment.injectScript).toBeUndefined();
    expect(assessment.paths).not.toContain("solver");
  });

  it("refuses to spend a solve on a challenge with no site key", async () => {
    const interstitial = page({ title: "Just a moment...", refs: [] });
    const assessment = await assessChallenge(interstitial, { solver: configuredSolver, solve: true });
    expect(assessment.solverOutcome?.ok).toBe(false);
    expect(assessment.solverOutcome?.message).toContain("no site key");
    expect(assessment.injectScript).toBeUndefined();
  });

  it("pauses for a person only when human assist is on and something is actually gated", async () => {
    const off = await assessChallenge(humanPage, {});
    expect(off.needsHuman).toBeUndefined();
    expect(off.paths).not.toContain("human");

    const on = await assessChallenge(humanPage, { humanAssist: true });
    expect(on.paths).toEqual(["human"]);
    expect(on.next).toBe("human");
    expect(on.needsHuman?.reason).toContain("gated by");
  });

  it("never marks a gated page passed", async () => {
    for (const options of [{}, { persistentProfile: true }, { solver: configuredSolver, solve: true }]) {
      const assessment = await assessChallenge(gatedPage, options);
      expect(assessment.passed).toBe(false);
    }
  });
});

describe("the solver seam", () => {
  it("is not configured without a key, and says so in a sentence", async () => {
    const solver = createSolver(null);
    expect(solver.configured).toBe(false);
    const result = await solver.solve({ kind: "hcaptcha", siteKey: "k", pageUrl: "https://x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_configured");
  });

  it("refuses a kind with no injectable token instead of spending a solve", async () => {
    const solver = createSolver({ provider: "2captcha", apiKey: "test-key" });
    const result = await solver.solve({ kind: "cloudflare_interstitial", siteKey: "k", pageUrl: "https://x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported_kind");
  });

  it("reads configuration from the environment and never invents a key", () => {
    expect(solverConfigFromEnv({})).toBeNull();
    const config = solverConfigFromEnv({ CAPTCHA_SOLVER_API_KEY: "k", CAPTCHA_SOLVER_PROVIDER: "2captcha" });
    expect(config?.provider).toBe("2captcha");
    // An unknown provider is a seam we do not silently reinterpret.
    expect(solverConfigFromEnv({ CAPTCHA_SOLVER_API_KEY: "k", CAPTCHA_SOLVER_PROVIDER: "other" })).toBeNull();
  });

  it("creates a task, polls until ready, and returns the token", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    let polls = 0;
    // The **task API v2** shapes, as documented: JSON bodies on api.2captcha.com,
    // `errorId` + `taskId` on creation, `status: processing|ready` on polling.
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, body: JSON.parse(String(init?.body ?? "{}")) });
      if (href.endsWith("/createTask")) {
        return new Response(JSON.stringify({ errorId: 0, taskId: 74372499131 }), { status: 200 });
      }
      polls += 1;
      return polls === 1
        ? new Response(JSON.stringify({ errorId: 0, status: "processing" }), { status: 200 })
        : new Response(
            JSON.stringify({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "token-abc" } }),
            { status: 200 },
          );
    }) as unknown as typeof fetch;

    const solver = createSolver({ provider: "2captcha", apiKey: "test-key", timeoutSeconds: 30 }, fakeFetch);
    const result = await solver.solve({
      kind: "recaptcha_v2_checkbox",
      siteKey: "site-key",
      pageUrl: "https://app.example.com",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("token-abc");
      expect(result.provider).toBe("2captcha");
    }

    const create = calls[0]!;
    // The one host that speaks the task API.
    expect(create.url).toBe("https://api.2captcha.com/createTask");
    const body = create.body as { clientKey: string; task: Record<string, unknown> };
    expect(body.clientKey).toBe("test-key");
    expect(body.task.type).toBe("RecaptchaV2TaskProxyless");
    expect(body.task.websiteKey).toBe("site-key");
    expect(body.task.websiteURL).toBe("https://app.example.com");
    // No legacy form fields may ride along.
    expect(body).not.toHaveProperty("method");

    const poll = calls[1]!;
    expect(poll.url).toBe("https://api.2captcha.com/getTaskResult");
    expect(poll.body).toEqual({ clientKey: "test-key", taskId: 74372499131 });
  }, 20_000);

  it("reports an unsolvable task by the vendor's error code, not by a numeric status", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ errorId: 12, errorCode: "ERROR_CAPTCHA_UNSOLVABLE", errorDescription: "Workers could not solve" }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const solver = createSolver({ provider: "2captcha", apiKey: "k" }, fakeFetch);
    const result = await solver.solve({ kind: "hcaptcha", siteKey: "s", pageUrl: "https://x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("solver_error");
      expect(result.message).toContain("ERROR_CAPTCHA_UNSOLVABLE");
    }
  });

  it("bounds every request by the deadline, so a stalled solver cannot outlive it", async () => {
    // A fetch that never resolves on its own and only rejects when aborted.
    const fakeFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as unknown as typeof fetch;

    const solver = createSolver({ provider: "2captcha", apiKey: "k", timeoutSeconds: 1 }, fakeFetch);
    const started = Date.now();
    const result = await solver.solve({ kind: "hcaptcha", siteKey: "s", pageUrl: "https://x" });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    // The important part: it returned, near its own deadline, instead of hanging.
    expect(elapsed).toBeLessThan(4000);
  }, 10_000);

  it("never puts the key in the returned token or the failure message", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ errorId: 1, errorCode: "ERROR_WRONG_USER_KEY" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const solver = createSolver({ provider: "2captcha", apiKey: "super-secret-key" }, fakeFetch);
    const result = await solver.solve({ kind: "hcaptcha", siteKey: "k", pageUrl: "https://x" });
    expect(JSON.stringify(result)).not.toContain("super-secret-key");
  });
});

describe("loader-only signals stay advisory", () => {
  it("does not call a page gated when only the reCAPTCHA library is loaded", () => {
    // A login page that calls grecaptcha.execute on submit has the library, and
    // nothing in the way. Saying "gated" here stops a working page being used.
    const detection = detectCaptcha({
      frameUrls: ["https://www.google.com/recaptcha/api.js?render=6Lc_siteKey000000000000000"],
      title: "Sign in",
      text: "Email Password Sign in",
    });
    expect(detection.signals[0]?.kind).toBe("recaptcha_v3");
    expect(detection.signals[0]?.advisory).toBe(true);
    expect(detection.gated).toBe(false);
    expect(detection.primary).toBeUndefined();
    expect(describeDetection(detection)).toContain("not gated");
    expect(describeDetection(detection)).toContain("Continue normally");
  });

  it("turns the same loader into a gate once the challenge furniture is present", () => {
    const detection = detectCaptcha({
      frameUrls: [
        "https://www.google.com/recaptcha/api.js?render=6Lc_siteKey000000000000000",
        "https://www.google.com/recaptcha/api2/anchor?k=6Lc_checkboxKey00000000000",
      ],
      html: '<textarea id="g-recaptcha-response"></textarea>',
    });
    expect(detection.gated).toBe(true);
    expect(detection.primary?.advisory).toBeUndefined();
  });

  it("treats a bare holding-page title as a hint, not a gate", () => {
    const detection = detectCaptcha({ title: "Please wait", text: "" });
    expect(detection.signals[0]?.kind).toBe("unknown_challenge");
    expect(detection.signals[0]?.advisory).toBe(true);
    expect(detection.gated).toBe(false);
  });

  it("still treats a challenge frame as a real gate", () => {
    const detection = detectCaptcha({
      title: "Please wait",
      frameUrls: ["https://verify.example.com/challenge/frame"],
    });
    expect(detection.gated).toBe(true);
    expect(detection.primary?.kind).toBe("unknown_challenge");
    expect(detection.solvable).toBe(false);
  });
});

describe("token injection", () => {
  it("writes the token into the field the widget reads, for each kind", () => {
    const recaptcha = tokenInjectionScript(
      { kind: "recaptcha_v2_checkbox", confidence: "high", evidence: "", siteKey: "k" },
      "tok",
    );
    expect(recaptcha).toContain("g-recaptcha-response");
    expect(recaptcha).toContain('"tok"');

    const hcaptcha = tokenInjectionScript({ kind: "hcaptcha", confidence: "high", evidence: "" }, "tok");
    expect(hcaptcha).toContain("h-captcha-response");

    const turnstile = tokenInjectionScript({ kind: "turnstile", confidence: "high", evidence: "" }, "tok");
    expect(turnstile).toContain("cf-turnstile-response");
  });

  it("escapes the token so a quote in it cannot break out of the script", () => {
    const script = tokenInjectionScript({ kind: "hcaptcha", confidence: "high", evidence: "" }, 'a"b');
    expect(script).toContain('"a\\"b"');
  });
});

describe("solver requests", () => {
  it("needs a site key, and says nothing rather than guessing one", () => {
    const detection = detectCaptcha({ title: "Just a moment..." });
    expect(solverRequestFor(detection, "https://x")).toBeNull();
    const keyed = detectCaptcha({
      frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html"],
      html: '<div data-sitekey="10000000-ffff-ffff-ffff-000000000001"></div>',
    });
    expect(solverRequestFor(keyed, "https://x.example")?.siteKey).toBe("10000000-ffff-ffff-ffff-000000000001");
    // An unknown page URL is refused rather than sent as an invalid task.
    expect(solverRequestFor(keyed, "")).toBeNull();
  });
});

describe("the tool index", () => {
  it("finds tools by the situation a model is in, not just by name", () => {
    expect(findTools("the page is gated and clicks do nothing")[0]?.name).toMatch(/assessChallenge|readPage/);
    expect(findTools("captcha")[0]?.category).toBe("challenge");
    expect(findTools("fill a form")[0]?.name).toBe("runSteps");
    expect(findTools("stale token")[0]?.name).toBe("observeWindow");
    expect(findTools("keep me signed in")[0]?.name).toBe("prepareBrowser");
  });

  it("lets every export in the index resolve, so discovery cannot promise a tool that does not exist", async () => {
    const { TOOL_INDEX } = await import("../src/index.ts");
    const surface = (await import("../src/index.ts")) as Record<string, unknown>;
    for (const entry of TOOL_INDEX) {
      expect(typeof surface[entry.name], `${entry.name} must be exported`).toBe("function");
    }
  });

  it("says what a costly call buys, so a model can budget", () => {
    const screenshot = findTools("screenshot").find((entry) => entry.name === "screenshot");
    expect(screenshot?.cost).toBe("expensive");
    expect(screenshot?.resultNote).toContain("thousands of tokens");
  });
});
