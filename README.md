# domain-expiry-check

**Find out a domain is about to expire from a failed build, not from a dead website.**

A GitHub Action and CLI that reads each domain's expiry date, registrar and lifecycle stage **live from its registry over RDAP**, then warns or fails before anything lapses. No API key, no account, no third-party server between you and the registry.

```
✓ github.com                       Active, expires 2028-10-09 (713 days left), MarkMonitor Inc.
✓ bbc.co.uk                        Active, expires 2034-12-13 (2969 days left), British Broadcasting Corporation
! client-site.com                  Expires soon, expires 2026-11-14 (18 days left), Namecheap, Inc.
✗ old-campaign.net                 Redemption period, expires 2026-09-30 (expired 27 days ago), GoDaddy.com, LLC
```

## GitHub Action

Check every domain you or your clients depend on, every Monday:

```yaml
name: Domain expiry
on:
  schedule:
    - cron: '0 8 * * 1'
  workflow_dispatch:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: webvoguetech/domain-expiry-check@v1
        with:
          domains: |
            example.com
            example.co.uk
            client-site.com
          warn-days: 30   # annotate a warning inside 30 days
          fail-days: 7    # fail the job inside 7 days
```

A failed scheduled run emails the repository owner, so the alert reaches you with nothing else to set up. The run summary shows a table of every domain:

| | Domain | Stage | Expires | Days left | Registrar |
|---|---|---|---|---|---|
| ✅ | `github.com` | Active | 2028-10-09 | 713 | MarkMonitor Inc. |
| ⚠️ | `client-site.com` | Expires soon | 2026-11-14 | 18 | Namecheap, Inc. |

### Inputs

| Input | Default | Meaning |
|---|---|---|
| `domains` | (required) | Domains separated by spaces, commas or new lines. Lines starting `#` are ignored. |
| `warn-days` | `30` | Warning annotation when a domain expires within this many days. |
| `fail-days` | `7` | Fail the step within this many days. `-1` never fails on days alone. |

A domain that is **past expiry, in redemption, pending delete, on hold or not registered at all** always fails. A registry that doesn't answer, or a TLD with no RDAP service yet, only warns: someone else's outage shouldn't break your build.

### Outputs

`failed` (comma-separated domains), `soonest-domain`, `soonest-days`.

## CLI

```sh
npx domain-expiry-check example.com client-site.com --warn-days 30 --fail-days 7
npx domain-expiry-check example.com --json
```

Exits `1` when any domain fails, so it slots into cron jobs and scripts.

## How it works

1. IANA's [RDAP bootstrap file](https://data.iana.org/rdap/dns.json) names the authoritative RDAP server for each TLD.
2. The domain is asked for directly at that registry, the source WHOIS mirrors copy from.
3. Status codes are read before dates: a domain in its auto-renew grace period still shows a past expiry date and is fine, while one in redemption is in trouble whatever its date says.

Subdomains are resolved to the registered name (`app.example.com` → `example.com`). Most gTLDs and many ccTLDs publish RDAP. A few, `.us` among them, still only answer WHOIS, and those are reported as such rather than guessed at.

## Rather have an email?

A CI job only runs when it runs. [**DropPerch**](https://dropperch.com/?utm_source=github&utm_medium=readme&utm_campaign=domain-expiry-check) watches your domains every day with the same registry lookups. It emails you before a renewal is missed, and through grace, redemption and the drop if one is. It also has a free [domain expiry checker](https://dropperch.com/tools/domain-expiry-checker.html?utm_source=github&utm_medium=readme&utm_campaign=domain-expiry-check) and a [bulk checker](https://dropperch.com/tools/bulk-domain-expiry-checker.html?utm_source=github&utm_medium=readme&utm_campaign=domain-expiry-check) for up to 100 domains.

MIT licensed. Built by [Web Vogue Technologies](https://dropperch.com/about.html?utm_source=github&utm_medium=readme&utm_campaign=domain-expiry-check).
