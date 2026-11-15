# Blockchair — a Vineyard plugin pack

Looks up addresses and transactions on Bitcoin and the six chains built like it — Bitcoin Cash,
Litecoin, Bitcoin SV, Dogecoin, Dash and Zcash (transparent addresses) — through the
[Blockchair API](https://blockchair.com/api), with the analyst's own key.

What it adds over keyless sources: one API for all seven UTXO chains, Bitcoin SV included (no keyless
source was found for it); an address's first and last use without paging through its history; and
100 addresses per request, which is also how it tells which of Bitcoin, Bitcoin Cash and Bitcoin SV
a legacy `1…` address was used on.

> **Not verified against the live API.** No Blockchair key was available when this pack was
> written (2026-11-15). Every answer the tests use is shaped from Blockchair's API documentation
> (v2.0.80), except two error answers measured without a usable key. Before the pack is published,
> run `live-test.mjs` with a key (below); it checks each assumption the code makes about the answers.

## Plugins

| Plugin | Takes | Adds |
| --- | --- | --- |
| **Blockchair Address Summary** | Crypto Address on one of the seven networks | Confirmed `balance` (`balance_as_of`, `balance_source`), `first_seen`, `last_seen`, `address_kind`, and `blockchair_received`, `blockchair_spent`, `blockchair_first_received`, `blockchair_last_received`, `blockchair_first_spent`, `blockchair_last_spent`, `blockchair_output_count`. 100 addresses per request. Creates nothing |
| **Blockchair Address Transactions** | Crypto Address | The latest (or earliest) transactions as Crypto Transactions, each linked `input to` from the addresses it spends from and `output to` the addresses it pays; `tx_count`, `history_examined`, `history_complete` on the address |
| **Blockchair Transaction** | Crypto Transaction | `block_height`, `block_time`, `status`, `fee`, `tx_kind` and counts on the node, and the same `input to` / `output to` links |
| **Blockchair Network Check** | Crypto Address whose `network` is `unknown` | A Crypto Address on each network the string was used on, linked `same address on` from the unknown one |

Types are the Cryptocurrency type pack's (`run.vineyard.typepacks.cryptocurrency` 1.0.0), and the
link labels and data keys are the ones its page fixes for UTXO chains.

## Setup

1. Get a Blockchair API key: [blockchair.com/api/plans](https://blockchair.com/api/plans). The plan
   page could not be read by an automated client, so plan names and prices are not stated here.
2. In Vineyard, open **Run plugins**, pick a Blockchair plugin and paste the key into its settings.
   All four plugins call the same host, so the key is entered once.

Works in the web app and the desktop app: Blockchair answers with `Access-Control-Allow-Origin: *`,
its error answers included (measured 2026-11-14), and the key travels in the query string, so a
request is a plain GET with no preflight.

## Terms

- Blockchair's API documentation: keyless use is allowed only for personal use or testing, and for
  non-commercial or academic projects, up to 1,440 requests a day; **commercial projects need a key
  whatever the volume**. With a key, Blockchair says an IP is never blocked.
- The same documentation asks that a key be kept secret and that public apps proxy their requests.
  Each analyst enters their own key on their own device; no key is bundled or shared.
- Blockchair receives every address and transaction looked up, with the key. Blockchair's terms of
  service are at [blockchair.com/terms](https://blockchair.com/terms) (that page, too, refused an
  automated client; read it before relying on the data in a product).

## Why it is shaped this way

**Canonical forms in, canonical forms out.** The type pack identifies an address by its network and
its string, and folds letter case only. So the pack writes the form the type pack names for each
network — CashAddr without `bitcoincash:` for Bitcoin Cash, `M…` for a Litecoin `3…`, legacy Base58
for Bitcoin SV, lower-case bech32 — and asks Blockchair in that form too. Every address is decoded
and its checksum checked before it is sent (`src/codec.ts`), so a typo is refused rather than coming
back as "never used". The pack never rewrites a selected node's own spelling; a selected node in a
non-canonical form is matched to the canonical one in the run, so a transaction that lists it links
to that node instead of making a second one.

**Token-aware CashAddr.** A `z…`/`r…` address (CashTokens) locks to the same script as the `q…`/`p…`
of the same hash. Blockchair's documentation predates CashTokens, so the pack asks for the `q…`/`p…`
form; the node keeps its spelling, and counterparties are written as Blockchair lists them.

**A transaction is a node, and a pair has one link.** `input to` carries `amount` (that address's
total across the transaction's inputs) and `inputs` (`index`, `amount`, `prev_txid`, `prev_vout`);
`output to` carries `amount` and `outputs` (`index`, `amount`). A link that already exists under
another label keeps it — whoever wrote it — and only gets these keys. One that already has the label
this pack would write is compared key by key with what this run would write, from the copy of the
link's data the app hands plugins: the same data is left as it is, and other amounts, or none (a
link someone else drew), are replaced with this run's. A re-run over the same transactions
therefore puts no link rows in the review. An older app handed plugins a link's id, endpoints and
label only; there a same-label link is left as it is, because what this pack writes on a link is
fixed by the transaction and restating it would put one identical row per link in the review, and
the summary counts the links it left alone. Network Check's `same address on` links are restated
when their data cannot be read, because what they say does change (below). At most 100 entries per
link (`inputs_omitted` counts the rest); the amount is always the full total.

**History fields say what the graph holds.** Address Transactions writes `history_examined` and
`history_complete` only when every transaction it read for the address was drawn. If a run stops
(a used-up quota, say) or a transaction cannot be read, the address still gets its balance and dates,
but those two fields are left as they were and the summary says which addresses to run again.

**Largest counterparties first.** An exchange payout can have thousands of outputs. Per transaction,
each side draws the selected addresses and then the largest `max_counterparties` others;
`blockchair_not_drawn` on the transaction node says how many were left out, and is written as 0 too,
so a later run with a higher cap can say the picture is complete. A run never raises it: the links an
earlier run drew stay on the graph, so a later run with a smaller cap (Address Transactions defaults
to 25 per side, Blockchair Transaction to 50) leaves the lower count standing, and only a lower count
replaces it.

**Counterparties are written with their identity only.** `network` and `address`, nothing else, so an
address already in the project is linked to and not overwritten.

**"Never used" only from an answer that could say so.** The 100-address dashboard leaves out
addresses that were never in a transaction ("`data.addresses` … don't include addresses which don't
participate in transactions", API docs), which after a canonical query is a real negative. It is
only read that way from an answer that carries the `addresses` list. A 404 is a failed lookup unless
it is Blockchair's JSON naming no error, and even then a missing `data` fails it: Blockchair's docs
give 404 both to "no results" (deprecated) and to a route it does not serve, and a proxy in front can
answer 404 with a page. An entry listed with nothing ever received also counts as never used, in
case the live API lists such addresses after all.

**"Never used" is said in a way that cannot go stale.** It is written as a
zero balance and `blockchair_output_count: 0`, not `tx_count: 0`: that dashboard never gives a
transaction count, so a zero count would survive the address's first use. `tx_count` comes only from
the single-address dashboard, which Address Transactions reads.

**First use, and whose figure it is.** `first_seen` is the earlier of the first receipt and the first
spend; Blockchair's split is kept in the `blockchair_*` dates. Blockchair counts pay-to-public-key
outputs into the address of their key (the docs' genesis address shows a first receipt on
2009-01-03), which some explorers do not, so early balances and first-use dates can differ between
sources: `balance_source` says whose a balance is.

**Confirmed only.** Every address call uses `state=latest`, so mempool transactions are left out of
balances, totals, dates and transaction lists.

**Exact amounts.** Amounts are decimal strings in the network's whole unit (8 decimals on all seven).
Blockchair sends them as JSON numbers in the smallest unit, and Dogecoin has no supply cap, so one
wallet's balance can pass 2^53; the answer is parsed with large integers kept as text
(`src/values.ts`).

**Network Check's verdict is its own.** A `same address on` link carries `check_blockchair`:
`basis` (`activity`, or `format` when only one network has that format), `as_of` (the date of
Blockchair's answer) and, for an address valid on several networks, `candidates`. Under one key,
because the app merges link data by top-level key and other sources settle the same pairs (a
sanctions-list screening that names the network, for one, writes its own `basis`): shared top-level
keys would leave one source's verdict beside another's date, and each re-run would overwrite the
other source's record.

**Shared history before a split.** A `1…` address used before 2017-08-01 has that history on Bitcoin
and Bitcoin Cash, and before 2018-11-15 on Bitcoin SV too. Network Check makes a node on each network
with activity — separate accounts that share a string — and says so in the summary. A `D…` address is
Dogecoin's and also Verge's, which Blockchair does not serve, so an unused `D…` stays unsettled.

**The key is in every URL.** Blockchair has no header for it. Every message the pack writes — summary,
progress log — passes through `redact`, which removes the key in any form, because a host error such
as "network egress denied: GET <url>" would otherwise carry it into the run's record.

**Errors.** As Blockchair documents them, two measured: a key it does not know is 402 "Invalid API
token" (measured), a used-up quota is also 402 (the message tells them apart), 429 and 435 are waited
out and retried, 430 and 434 are an IP block (measured: 430 on a keyless request), 436 and 437 are
limits. A condition that will repeat ends the run: before anything was staged it fails with the cause,
after that it returns what it has and says STOPPED. A 400 for a batch is split in halves and asked
again, so one address Blockchair will not take fails alone rather than with the 99 sharing its
request; at most 16 halvings per lookup, so a 400 that every request gets costs 33 requests for a
batch of 100, not 199. (The validator accepts formats newer than the documentation, such as a P2SH32
CashAddr or a SegWit v2–16 address; whether Blockchair refuses them is not known without a key.)

**Ten minutes.** The app ends a plugin run at 10 minutes and keeps nothing it staged, and a run's
length is not something the manifest can raise (the registry schema has no key for it). At the
manifest's own maximums Address Transactions could pass it: 100 addresses × 100 transactions at
600 ms a request is 1,100 requests, 11 minutes. So after 7 minutes no plugin starts on a new
address or batch (Address Transactions still draws the addresses it has read), and none sends a
request or begins a wait that would end past 9; the run then returns what it has and says STOPPED,
with how many addresses or transactions to run again. Address Transactions draws transactions as it
goes, ten per request, rather than reading every address first: the addresses it reached are the
ones drawn, and the ones it did not reach were never asked about, so no points went on them.

**Request points.** Blockchair charges in points: 1 per single call, 1 + 0.1 per further address on
the 100-address dashboard (10.9 for 100), 1.9 for ten transactions, +1 for transaction details. Each
run's summary adds up the `request_cost` Blockchair reports.

## Build and test

```sh
node build.mjs          # bundles src/main.ts into dist/pack.mjs (esbuild 0.25.12, pinned)
node gen-manifest.mjs   # regenerates plugins/blockchair.manifest.json from the bundle
node test-plugin.mjs    # plugins against documented and measured answers; no network
node test/pure.test.mjs # address encodings, amounts, the transaction plan
```

`node build.mjs && git diff --exit-code dist/pack.mjs` checks the published bundle against this
source.

`BLOCKCHAIR_API_KEY=… node live-test.mjs` runs every plugin against the live API on a handful of
well-known addresses and transactions, one never-used address, a Litecoin `M…` and a Bitcoin SV
address (about 18 requests, some 38 points), and checks each assumption about Blockchair's answers,
including that a 404 for an unknown route is a failed lookup and whether Blockchair refuses a SegWit
v2 address. The key is read from the environment
only and never printed. **It has never been run against the live API.** Run with global `fetch`
stubbed to docs-shaped answers (2026-11-15), it runs to the end; that checks the script, not the
API.

## License

Apache-2.0. Data returned by Blockchair is subject to Blockchair's terms of service.
