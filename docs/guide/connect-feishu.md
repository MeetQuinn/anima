---
title: Connect an agent to Feishu
description: Create or connect a Feishu app, publish its permissions, and start the first agent conversation.
---

# Connect an agent to Feishu

Each Anima agent uses its own Feishu app and bot identity. The default setup asks Feishu to create the app for you; an existing-app path is available when automatic registration cannot be used.

Start from the Feishu sequence during agent creation. For an existing unconnected agent, open its **Profile** tab and find the Feishu section.

## Before you start

You need a Feishu account that can create or authorize an app in the target tenant. App availability and API permissions are separate controls: a permission can be granted while the bot is still invisible to some teammates.

## 1. Create the agent

Choose **Feishu** on the first-run platform screen, then enter the agent's name, role, and provider. When you select **Create agent**, Anima starts Feishu app registration using that name and role.

This can take several seconds. A longer wait is not a reason to create a second app.

## 2. Confirm the new app in Feishu

On desktop, scan the QR code with Feishu or open the browser link below it. On mobile, select **Open Feishu**.

Confirm the app in Feishu. Anima keeps polling the registration and continues when Feishu reports the connection.

The person who confirms the automatically created app becomes the initial owner for onboarding.

## 3. Authorize the recommended permissions

The next Anima step groups the missing permissions by capability.

1. Open each permission group Anima shows and grant the requested scopes in Feishu.
2. In the Feishu developer console, **publish a new app version**. Feishu does not apply the new permissions until a version is published.
3. Return to Anima and select **Recheck access**.

When every recommended permission is active, select **Start activity**. The agent can now recognize teammates, participate in group conversations, look people up when authorized, and work with the Feishu document surfaces covered by those scopes.

You can skip the recommended set, but the connection will have reduced capabilities. The agent may still send and receive basic messages while teammate lookup, group work, or document actions fail until the missing permissions are granted and published.

## Existing-app fallback

If automatic app creation fails, Anima offers **Connect an existing Feishu app**.

1. Open the app's **Credentials & Basic Info** page in the Feishu Open Platform developer console.
2. Copy its App ID, beginning with `cli_`.
3. Paste the App ID and App Secret into the dashboard.
4. Select **Connect Feishu app**.

Use the dashboard fields only. Do not paste the App Secret into Feishu chat, source files, screenshots, or support messages.

The existing app must already be configured as a bot that can receive Feishu events over a long-lived connection. This fallback cannot identify the human owner, so it does not send the automatic owner greeting. Start the first conversation with the bot yourself.

## Troubleshooting

### Recheck still says no permissions are active

Publish a new app version, wait briefly for Feishu to apply it, then recheck. Granting scopes without publishing is not enough.

### Only some permissions are active

Add the still-missing scopes, publish another version, and recheck. The Profile tab keeps the same permission diagnostic after onboarding.

### A teammate cannot find or use the app

Update the app's availability range in the Feishu developer or admin console. API scopes do not widen app visibility.

### An invite fails with Feishu code `232024`

The target user is outside the app's availability range. Add that person, department, or all members to the allowed range, publish or save the change, then retry once.

## What is stored

The Feishu App ID and App Secret are stored locally in the agent configuration and injected at runtime. Secret values are hidden in the dashboard. See [Security and data](../security-and-data.md) for the host and credential boundaries.

