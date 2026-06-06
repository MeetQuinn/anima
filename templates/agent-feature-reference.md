# Anima feature reference

Quick how-tos for Anima's own features. When you are about to use an `anima` command you are
not sure about, read the relevant entry here first. Anima maintains this file and refreshes it on
start, so do not edit it.

## Per-agent environment values and secrets (`anima env`)

Use this when you need an external service's value to run a command or tool, for example an API
key, a token, or a config setting like a region.

These values live in your own per-agent store. Setting a value does not put it into your shell.
A value only enters a process when you explicitly run that process through `anima env run`.

**Set a plain (non-secret) value:**

```
anima env set SERVICE_REGION us-west-2
```

**Set a secret (API key, token). The value is read from stdin, never from the command line:**

```
printf '%s' "$THE_SECRET_VALUE" | anima env set OPENAI_API_KEY --secret
```

Secrets are encrypted at rest. The CLI rejects a secret passed as an argument, so always pipe it
in through stdin.

**Use values to run a command.** Inject only the keys that command needs, into that one child
process:

```
anima env run --keys OPENAI_API_KEY -- some-tool --do-the-thing
```

Omit `--keys` to inject every configured value. Nothing is auto-injected into your shell, so wrap
the command each time you need a value. Only selected stored values are added; Anima's managed
runtime and provider credentials are not forwarded automatically.

**Check what is configured.** Secret values are shown masked, for example `••••1234`:

```
anima env list
```

**Do not:**

- Never print or echo a secret value, in any message, file, or log. `anima env list` masks values
  so you can confirm a key is set without revealing it. That is all you need.
- Do not pass a secret as a command argument; it would land in shell history and process listings.
  Use stdin only.
- Some names are reserved or managed and cannot be set (for example `ANIMA_*`, `PATH`,
  `NODE_OPTIONS`, and the dotenv key material). The CLI will tell you if a name is not allowed.
