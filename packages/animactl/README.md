# @meetquinn/animactl

Operator CLI for installing and running Anima from npm.

```bash
npx -y @meetquinn/animactl start
npx -y @meetquinn/animactl dashboard
npx -y @meetquinn/animactl restart
npx -y @meetquinn/animactl@canary restart
npx -y @meetquinn/animactl status
npx -y @meetquinn/animactl stop
```

This package installs the selected `@meetquinn/animactl` runtime into
`~/.anima/runtime/current` and runs services from that pinned runtime. Durable Anima data remains
in `~/.anima`. `start` launches the dashboard automatically on a local desktop; use `dashboard` to
launch it again. Use `restart` for command-line upgrades; with no version suffix, `npx` selects the
`latest` npm dist-tag.
