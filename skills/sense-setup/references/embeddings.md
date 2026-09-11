# Embedding setup

Read this guide when choosing an embedding provider or model, supporting a non-English tree, changing chunk size, or tuning signal weights.

## Provider choice

`static` loads a local Model2Vec model in JavaScript. The default model is `minishlab/potion-retrieval-32M`. A Hugging Face model id downloads into `~/.sense/models` on first vector use. A filesystem path points at a directory that already contains `model.safetensors` and `tokenizer.json`.

`openai` calls an OpenAI-compatible `/embeddings` endpoint. Local Ollama and LM Studio servers use this protocol. A hosted endpoint sends note text to that service.

`cohere` calls Cohere's native embedding endpoint. The `key` setting names the environment variable that contains the credential. Note text leaves the machine.

## Model choice

The default static model is English-only. For another language, choose a model whose published card declares that language. A static Model2Vec model must have compatible safetensors and tokenizer files with supported floating-point weights.

Sense checks declared model languages against the indexed tree. A clear mismatch raises `EMBED_MODEL_MISMATCH`. A model card with no language declaration cannot be checked, so confirm it before indexing.

For a static model, inspect current Model2Vec models and their cards rather than relying on a fixed list in this skill. For a local HTTP provider, inspect the model catalog exposed by the chosen runtime. Model availability and model cards change independently of sense releases.

## Download and rebuild behavior

Naming a remote static model in the config authorizes its download. `sense download` performs that fetch before the first query. The first vector-participating search then embeds the indexed notes.

Changing the model changes the vector space and rebuilds embeddings. Changing preset coverage can also add, remove, or rebuild vector rows. Settle the broad scope before embedding a large tree.

## Chunk size

`embed.chunkTokens` sets the estimated token ceiling for chunks. The default is 500. Sense splits at headings and then applies the ceiling to long sections. Lower it for an embedding model with a smaller useful context window. Raising it trades fewer vectors for less precise line ranges and more text per vector.

## Signal weights

A preset includes a signal by naming it:

```json
"signals": { "words": 1, "links": 1, "vectors": 1 }
```

The number is the signal's reciprocal-rank weight. It is not a boolean. Weight 1 gives equal contribution. A higher vector weight can help a strong encoder on some corpora and hurt another tree whose exact vocabulary carries the answer.

Test representative questions from the actual tree before changing weights. Compare returned paths and evidence labels, not only the fused score.

## Layers without vectors

An `embed` block makes vectors available to the tree. A preset can still omit the vector signal:

```json
"signals": { "words": 1, "links": 1 }
```

Use that for layers where exact wording matters more than paraphrase, such as raw sources, archives, generated logs, or citation corpora. Those files can remain indexed without paying the embedding cost for that preset's scope.
