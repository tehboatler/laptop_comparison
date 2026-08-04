/**
 * Perplexity Sonar client (OpenAI-compatible).
 * Docs: https://docs.perplexity.ai
 *
 * Env:
 *   PERPLEXITY_API_KEY
 *   SONAR_MODEL          default sonar (sonar-pro = slower/harder research)
 *   SONAR_BASE           default https://api.perplexity.ai
 *   SONAR_DELAY_MS       pause between successful calls (default 2500)
 *   SONAR_RETRY_MAX      retries on 429/5xx (default 5)
 *   SONAR_RETRY_BASE_MS  base backoff for 429 (default 15000)
 *   SONAR_MAX            default batch size for enrich scripts (default 3)
 */
function apiKey() {
  return (
    process.env.PERPLEXITY_API_KEY ||
    process.env.SONAR_API_KEY ||
    ""
  ).trim();
}

function hasSonarKey() {
  return !!apiKey();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function envInt(name, fallback) {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Default delay between Sonar jobs (ms). Raise if you hit 429 often. */
function sonarDelayMs() {
  return envInt("SONAR_DELAY_MS", 2500);
}

function sonarRetryMax() {
  return envInt("SONAR_RETRY_MAX", 5);
}

function sonarRetryBaseMs() {
  return envInt("SONAR_RETRY_BASE_MS", 15000);
}

/**
 * Default batch size. 0 / "all" = no cap (process every matching row).
 * Prefer unlimited for long jobs; use SONAR_DELAY_MS to pace API.
 */
function sonarDefaultMax() {
  const raw = String(process.env.SONAR_MAX ?? "0").trim().toLowerCase();
  if (raw === "" || raw === "all" || raw === "inf" || raw === "unlimited") {
    return 0; // 0 = no cap
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n; // 0 = all, N = cap
}

// Simple process-wide pacing so parallel callers don't stampede
let _lastCallAt = 0;
let _chain = Promise.resolve();

async function pace() {
  const delay = sonarDelayMs();
  if (delay <= 0) return;
  const now = Date.now();
  const wait = Math.max(0, _lastCallAt + delay - now);
  if (wait > 0) await sleep(wait);
  _lastCallAt = Date.now();
}

/**
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.system]
 * @param {string} [opts.model]
 * @param {boolean} [opts.json] request JSON object response when supported
 * @param {boolean} [opts.skipPace] skip inter-call delay (tests)
 */
async function sonarChat({ prompt, system, model, json = true, skipPace = false }) {
  // Serialize + pace all Sonar calls in this process
  const run = async () => {
    if (!skipPace) await pace();

    const key = apiKey();
    if (!key) throw new Error("PERPLEXITY_API_KEY not set");

    const base = (process.env.SONAR_BASE || "https://api.perplexity.ai").replace(
      /\/$/,
      ""
    );
    const useModel = model || process.env.SONAR_MODEL || "sonar";

    const body = {
      model: useModel,
      messages: [
        ...(system
          ? [{ role: "system", content: system }]
          : [
              {
                role: "system",
                content:
                  "You are a careful EU/UK laptop shopping researcher. Prefer manufacturer specs and reputable reviews (Notebookcheck, Laptop Mag, RTINGS, manufacturer pages). Never invent EANs or ASINs. If unsure, say null and explain in notes. Respond with JSON only when asked.",
              },
            ]),
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
    };

    const retryMax = sonarRetryMax();
    const retryBase = sonarRetryBaseMs();
    let attempt = 0;
    let lastErr = null;

    while (attempt <= retryMax) {
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(`Sonar non-JSON ${res.status}: ${text.slice(0, 300)}`);
        }

        if (res.status === 429 || res.status === 503 || res.status === 502) {
          attempt++;
          const retryAfterHdr = res.headers.get("retry-after");
          let waitMs = retryBase * Math.pow(1.6, attempt - 1);
          if (retryAfterHdr) {
            const sec = parseFloat(retryAfterHdr);
            if (!isNaN(sec) && sec > 0) waitMs = Math.max(waitMs, sec * 1000);
          }
          // cap one wait at 3 minutes
          waitMs = Math.min(waitMs, 180000);
          const msg =
            data?.error?.message ||
            data?.message ||
            JSON.stringify(data).slice(0, 120);
          if (attempt > retryMax) {
            throw new Error(
              `Sonar ${res.status} rate limit after ${retryMax} retries: ${msg}`
            );
          }
          console.warn(
            `  ⏳ Sonar ${res.status} — waiting ${Math.round(waitMs / 1000)}s (retry ${attempt}/${retryMax})…`
          );
          await sleep(waitMs);
          _lastCallAt = Date.now();
          continue;
        }

        if (!res.ok) {
          throw new Error(
            `Sonar ${res.status}: ${JSON.stringify(data).slice(0, 400)}`
          );
        }

        const content =
          data.choices?.[0]?.message?.content ||
          data.choices?.[0]?.message?.reasoning ||
          "";
        const citations =
          data.citations || data.choices?.[0]?.message?.citations || [];

        let parsed = null;
        if (json && content) {
          try {
            const cleaned = String(content)
              .replace(/^```json\s*/i, "")
              .replace(/^```\s*/i, "")
              .replace(/\s*```$/i, "")
              .trim();
            parsed = JSON.parse(cleaned);
          } catch {
            const m = String(content).match(/\{[\s\S]*\}/);
            if (m) {
              try {
                parsed = JSON.parse(m[0]);
              } catch {
                parsed = null;
              }
            }
          }
        }

        _lastCallAt = Date.now();
        return {
          content: String(content || ""),
          parsed,
          citations: Array.isArray(citations) ? citations : [],
          model: useModel,
          raw: data,
        };
      } catch (err) {
        lastErr = err;
        const transient = /fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(
          String(err.message || err)
        );
        if (!transient || attempt >= retryMax) throw err;
        attempt++;
        const waitMs = Math.min(retryBase * attempt, 60000);
        console.warn(
          `  ⏳ Sonar network error — waiting ${Math.round(waitMs / 1000)}s (retry ${attempt}/${retryMax})…`
        );
        await sleep(waitMs);
      }
    }
    throw lastErr || new Error("Sonar failed");
  };

  // Queue so concurrent enrich calls still respect delay
  const next = _chain.then(run, run);
  _chain = next.catch(() => {});
  return next;
}

module.exports = {
  hasSonarKey,
  sonarChat,
  apiKey,
  sleep,
  sonarDelayMs,
  sonarDefaultMax,
  sonarRetryMax,
};
