# openclaw-plivo-phone-channel

Real-time voice conversations for an OpenClaw agent over **Plivo Audio Streaming**, inbound
and outbound, with barge-in and keypad input.

The Plivo provider bundled with OpenClaw drives the Voice API. This plugin uses Audio
Streaming instead, which is the seam a phone agent needs, and registers itself as a channel
rather than patching the bundled provider.

## Prerequisites

| Requirement | Description |
| --- | --- |
| Plivo account | [Sign up](https://cx.plivo.com/?utm_source=github&utm_medium=oss&utm_campaign=openclaw-plivo-phone-channel) and copy the Auth ID and Auth Token from the Plivo console |
| Phone number | A [voice-enabled Plivo number](https://cx.plivo.com/phone-numbers?utm_source=github&utm_medium=oss&utm_campaign=openclaw-plivo-phone-channel) in E.164 format |
| OpenClaw | A working install with its gateway, on Node 22 or newer |
| Public URL | A public HTTPS base URL. Plivo reaches the answer webhook over HTTPS and the audio stream over WSS on the same origin, so it must forward WebSocket upgrades as well as HTTP |

## Install

```bash
openclaw plugins install clawhub:plivo-phone
```

## Configure

Under `channels.plivo-phone` in the OpenClaw configuration.

```json
{
  "channels": {
    "plivo-phone": {
      "authId": "<plivo_auth_id>",
      "authToken": "<plivo_auth_token>",
      "fromNumber": "+14155550100",
      "publicWebhookUrl": "https://agent.example.com",
      "allowFrom": ["14155550111"],
      "allowDestinations": ["14155550222"]
    }
  }
}
```

`authId` and `authToken` are the only required settings, though a call needs `fromNumber`
and `publicWebhookUrl` as well before anything can reach the agent.

## What this changes in a Plivo account

Read this before the first start, because provisioning happens automatically.

Each time the gateway starts, the plugin creates or updates a Plivo **application** named
`openclaw-plivo-phone-<number>`, points its answer URL at the route this plugin serves, and
attaches the number to it. That is persistent call-routing state in a live Plivo account, not
local configuration, and it changes where calls to that number go.

An application the plugin did not create is never modified. Ownership is decided by the
application name, so a number answering through anything else is left alone and reported
rather than claimed. When ownership cannot be established, because the Plivo API returned an
error, the number is also left alone.

Set `autoWire` to `false` to disable all of this and point the application's answer URL at
the plugin by hand.

Removing the plugin does not undo the provisioning. `unwire` detaches the number and is the
counterpart to run first.

## Routes and provisioning

| Key | Default | Purpose |
| --- | --- | --- |
| `answerPath` | `/plivo-phone/answer` | Local answer-webhook route registered in OpenClaw |
| `streamPath` | `/plivo-phone/stream` | Local WebSocket route the audio stream connects to |
| `autoWire` | `true` | Whether the plugin creates the Plivo application and attaches the number at startup. Set `false` to configure Plivo by hand |

## Access control

The answer webhook verifies Plivo's callback signature. Each call mints a single-use token
that the audio stream requires, so knowing the stream path does not grant access to it.

| Key | Default | Purpose |
| --- | --- | --- |
| `dmSecurity` | `allowlist` | `allowlist` restricts callers to `allowFrom`. `open` admits any number, and every call spends model tokens |
| `allowFrom` | `[]` | Caller numbers permitted under `allowlist`. Digits only, because Plivo reports the caller without a leading plus |
| `allowDestinations` | `[]` | Numbers the agent may call. Independent of `allowFrom` and of `dmSecurity`. Empty refuses every outbound call |

Caller identification can be spoofed. The list is a filter rather than authentication.

## Duration limits

| Key | Default | Purpose |
| --- | --- | --- |
| `idleTimeoutSeconds` | `60` | Seconds with neither party making a sound, after which the call ends. `0` disables |
| `maxCallSeconds` | `600` | Maximum call length, measured from answer. `0` disables |

Plivo streams continuously, so a silent line still sends a frame every 20 ms. The idle timer
therefore measures audio energy rather than packets, and agent speech counts as activity so a
long reply is never cut off mid-sentence.

## The caller-facing agent

| Key | Default | Purpose |
| --- | --- | --- |
| `instructions` | none | System prompt for the agent on the call. Without one the caller reaches a bare realtime model with no brief |
| `greeting` | a short greeting | What the agent says on answering, before the caller speaks. An empty string waits for the caller instead |
| `logTranscripts` | `false` | Log transcribed speech. Off by default, because a phone transcript is the content of somebody's conversation |

A phone call differs from a chat window in that nobody speaks first into a silent line, so
the agent opens the conversation unless `greeting` is emptied.

## Inbound and outbound are separate decisions

Two independent lists, and neither grants the other.

| Setting | Governs | Empty means |
| --- | --- | --- |
| `allowFrom` with `dmSecurity: "allowlist"` | Who may call the agent | Every caller refused |
| `allowDestinations` | Who the agent may call | Every outbound call refused |

The same number may appear in both. Letting the inbound list stand in for the outbound one
would mean permission to call the agent also granted permission to be called by it, which is
a different decision, so no such fallback exists.

Plivo reports the party at the other end in a different field per direction. On an inbound
call the caller is in `From`. On an outbound call `From` holds the Plivo number and `To`
holds the person being called, so the plugin reads the direction before choosing the field
and the list.

Dialling is not this plugin's job. An outbound call is placed by the Plivo tools plugin with
its answer URL pointed at this plugin's answer route, so the call joins the same stream,
endpointer and turn loop an inbound caller reaches. This list still governs it, because the
answer route makes the decision.

## Development

```bash
npm install --legacy-peer-deps
npm run lint     # type-checks the sources and the tests
npm test
npm run build    # emits dist/, excluding the tests
```

`npm install` needs `--legacy-peer-deps`, because resolving the host as a peer alongside its
own dependency tree otherwise fails.

Every option is documented in `openclaw.plugin.json`. The full guide, including the
comparison against the bundled provider, the interruption and playback model, and
troubleshooting, is in
[the repository](https://github.com/plivo-sdks/openclaw-plivo-phone-channel).

## License

MIT. See [LICENSE](./LICENSE).
