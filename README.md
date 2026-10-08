# Durable news reader

A small Pi 1.1 news agent: Radius web research, classifier-assisted source selection,
and articles saved under `articles/`. Run with Node.js 24+.

```sh
npm install
npm start -- "Research the latest battery recycling developments and store a sourced article"
```

Authenticate Radius in Pi (`/login radius`) or set `RADIUS_API_KEY`.
The chat model defaults to `radius/deepseek-v4.1-flash`; override it with
`NEWS_AGENT_MODEL=provider/model-id` for a new session.

## Codemode + classifiers

The agent can run a JavaScript research script in Pi's QuickJS sandbox:

1. Search several angles concurrently with `Promise.allSettled`.
2. Deduplicate source URLs before paying to classify them.
3. Call `tools.classify_source({ topic, url, text })` for each candidate snippet.
4. Fetch shortlisted pages, returning only useful evidence and its source URLs.
5. Write the article with the ordinary file tools, outside the sandbox.

All three sandbox tools (`web_search`, `web_fetch`, `classify_source`) return text;
parse JSON responses with `JSON.parse`. The classifier returns `{ url, probability }`.
It judges **relevance**, not accuracy or credibility. The writer must still read
sources and check factual claims. Classification failures must be disclosed, not
replaced with invented scores.

The default classifier is `typesafe/jev-latest`. Set `TYPESAFE_API_KEY` or configure
that provider's credentials in Pi. Radius credentials alone do not enable it.
For a different classifier, set `NEWS_AGENT_CLASSIFIER`, for example
`openrouter/typesafe/jev-1.13` with OpenRouter credentials.

Try:

```sh
npm start -- "Use codemode to search three angles on battery recycling, deduplicate URLs, classify snippet relevance, and fetch the shortlist. Report which classifier ran and include its scores with the sources. Save a sourced article. If classification is unavailable, say so."
```

## Durability and limits

- SQLite state lives in `.news-agent/session.sqlite`. Only one process may own it.
- Restarting resumes unfinished work. The current CLI also submits the supplied
  prompt as a **new** request; repeating a command is not idempotent.
- Codemode is one replay-safe, read-only durable tool. A crash can rerun the whole
  script, including paid searches/classifications. Nested calls are not separate
  durable tasks and do not run individual durable tool hooks.
- Completed scripts record nested-call timings and reported classifier usage on
  the codemode result. Usage before a crash may not have been committed.
- Scripts have a 60-second deadline, 256 MiB VM heap, and 32 nested-call limit.
  Returned text is capped at 20,000 characters, with a truncation notice.
- `store`/`load` last for one script only. No filesystem, shell, or arbitrary network
  access is exposed inside codemode. The **outer agent still has coding tools**;
  the whole agent is not sandboxed.

## Checks

- `npm test`: offline tests using the real sandbox and mocked MCP/classifier calls.
- `npm run check`: live Radius search and chat-model catalog smoke check; does not
  verify classifier credentials or perform a paid classification.
