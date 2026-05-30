# @meetquinn/animactl

Operator CLI for installing and running Anima from npm.

```bash
npx @meetquinn/animactl start
npx @meetquinn/animactl@canary restart
npx @meetquinn/animactl status
npx @meetquinn/animactl stop
```

This package installs the `@meetquinn/animactl` runtime into `~/.anima/runtime/current` and runs
services from that pinned runtime. Durable Anima data remains in `~/.anima`.
