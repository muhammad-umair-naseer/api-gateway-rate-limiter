-- token_bucket.lua — the atomic core of the whole project.
--
-- WHY THIS EXISTS:
--   A token bucket in one process is trivial: `if tokens > 0 then tokens-- end`.
--   The trap is that "read tokens -> decide -> write tokens" is THREE operations.
--   Two concurrent requests can both read tokens=1, both decide "allow", both
--   write tokens=0 — admitting 2 requests against a budget of 1. That is a
--   check-then-act race, and across N processes an in-memory mutex can't fix it
--   because the state doesn't live in any one process — it lives in Redis.
--
--   Redis executes a Lua script ATOMICALLY: it is single-threaded and runs the
--   whole script to completion before servicing any other command. So the entire
--   read-refill-decide-write sequence below is indivisible. No interleaving is
--   possible. That is the mechanism. Rip this script out (see the naive JS path)
--   and the race instantly returns.
--
-- KEYS[1] = bucket key, e.g. "rl:acme"
-- ARGV[1] = capacity      (max tokens the bucket can hold)
-- ARGV[2] = refill_rate   (tokens added per second)
-- ARGV[3] = cost          (tokens this request wants to consume)
--
-- Returns: { allowed(1|0), remaining(int), retry_after_ms(int) }

local key         = KEYS[1]
local capacity    = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local cost        = tonumber(ARGV[3])

-- Use REDIS's clock as the single source of truth, NOT the caller's clock.
-- In a distributed limiter every gateway node talks to the same Redis, so
-- deriving "now" from Redis makes refill immune to client clock skew — a node
-- with a fast wall clock can't trick the bucket into refilling early.
local t   = redis.call("TIME")                       -- { seconds, microseconds }
local now = tonumber(t[1]) + tonumber(t[2]) / 1e6    -- seconds, as a float

-- Load prior state (tokens + timestamp of last refill).
local state  = redis.call("HMGET", key, "tokens", "ts")
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])

-- Cold bucket: start full. First-ever request for a tenant sees a fresh budget.
if tokens == nil then
  tokens = capacity
  ts     = now
end

-- LAZY REFILL: instead of a background job topping up every bucket on a timer,
-- we compute how many tokens *would* have accrued since we last touched this key.
-- O(1), no cron, and idle tenants cost nothing until their next request.
local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end                  -- clock never runs backwards here
tokens = math.min(capacity, tokens + elapsed * refill_rate)

-- Decide + consume, atomically with everything above.
local allowed = 0
if tokens >= cost then
  allowed = 1
  tokens  = tokens - cost
end

-- Persist new state.
redis.call("HSET", key, "tokens", tokens, "ts", now)

-- Expire idle buckets so Redis memory stays bounded: once a bucket could have
-- fully refilled from empty it carries no information, so let it evaporate and
-- be re-created full on the next request (harmless — it would have refilled).
if refill_rate > 0 then
  redis.call("EXPIRE", key, math.ceil(capacity / refill_rate) + 1)
else
  -- FROZEN bucket (refill_rate == 0): its remaining budget is meaningful
  -- forever. If we let it expire, the next request would find no key, re-init
  -- to full capacity, and hand out a brand-new budget — silently over-admitting
  -- and violating the "exactly capacity, ever" invariant. So never expire it,
  -- and clear any TTL a previous config may have left behind.
  redis.call("PERSIST", key)
end

-- Tell a throttled caller how long until it could succeed (Retry-After hint).
-- A value of -1 means "never retryable" — the request can never succeed as-is,
-- so a well-behaved client should give up rather than hot-loop.
local retry_after_ms = 0
if allowed == 0 then
  if cost > capacity then
    retry_after_ms = -1                              -- exceeds bucket size; impossible
  elseif refill_rate > 0 then
    retry_after_ms = math.ceil(((cost - tokens) / refill_rate) * 1000)
  else
    retry_after_ms = -1                              -- frozen bucket never refills
  end
end

-- Lua floats are truncated to ints on the way back to the client, so floor
-- explicitly to make "remaining" unambiguous.
return { allowed, math.floor(tokens), retry_after_ms }
