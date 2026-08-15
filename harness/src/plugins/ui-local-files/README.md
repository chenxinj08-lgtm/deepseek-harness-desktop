# @deepseek-ai/dsh-client-ui-local-files

English | [中文](README.zh.md)

Third-party vendor extension for DeepSeek Harness. The package name follows the Harness workspace convention and does not imply upstream support.

The browser plugin adds three official slot contributions: one file picker in `conversation.input.left`, one capture-phase paste/drop overlay in `conversation.input.overlay`, and removable local-file chips in `conversation.input.dock`. The picker and gestures accept one mixed batch. PNG, JPEG, WebP, and GIF files enter the existing image rail through `IConversation.stageDraftImages`; every other browser `File` enters the Host-local stream. Capturing the gesture prevents InputBar's fallback image listener from adding the same image twice.

The client inserts one ordinary U+FFFC input occurrence synchronously, then streams generic-file bytes in the background. If the user submits immediately, the source codec waits for the same atomic Host commit; a failed import blocks serialization instead of emitting a dangling reference. Submit serialization turns the occurrence into a short `<local_file id="…" name="…" size_bytes="…" />` marker. File bytes and extracted content are never serialized by the composer, and the Host remains authoritative for the sniffed reader kind.

Generic files use a same-origin raw `PUT`, not JSON, Base64, or multipart. The Host package owns validation, backpressure, storage, classification, and model tools. Images deliberately retain the upstream image lifecycle and its prompt serialization.

## Model Experience

### Rich-reference submit projection

#### What the model sees

Each rich composer occurrence serializes to one short `<local_file id="…" name="…" size_bytes="…" />` marker. Tool descriptions, authoritative reader kind, and bounded results are owned by `@deepseek-ai/dsh-host-local-files`.

#### Token effect

The marker costs only its metadata tokens; neither file bytes nor extracted content are serialized by this package.

#### KV Cache effect

The marker is append-only user content and leaves the preceding request prefix reusable.

## Known Limitations and Deferred Work

- Browser APIs expose a `File`, not an absolute operating-system path, so the Web surface streams a local staged copy to the Harness host.
- Standard `fetch` does not expose byte-level upload progress. The chip appears immediately and ingestion proceeds in the background; an immediate send waits for the atomic commit.
- Accepting every generic format does not imply a semantic parser for every format. Unknown or unsafe-to-decode content is stored as `binary` and exposed only through metadata and bounded byte windows.
- Upstream image submission still materializes each image and Base64-encodes it in the request; this package does not replace the image attachment lifecycle.
- Copying a chip produces `@local-file(<uuid>)`; pasting that plain text into a later page does not reconstruct a rich occurrence in this first version.
