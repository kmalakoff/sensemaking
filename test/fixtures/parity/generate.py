#!/usr/bin/env python3
"""Generate test/fixtures/parity/fixtures.json, the reference oracle for the
static embedding path, verified by diff against this Python reference rather
than by reasoning about the port.

For each fixed input string this records two things straight from the
reference Python implementations, never recomputed by hand:
  - token_ids: the raw output of Python `tokenizers`' Tokenizer.encode(text,
    add_special_tokens=False).ids, loaded directly from the model's
    tokenizer.json -- BEFORE any unk-filtering.
  - vector: the final embedding from model2vec's StaticModel.encode(text),
    called with max_length=None (see NOTE below).

Pinned model: minishlab/potion-retrieval-32M @
6fc8051fab2a1e0ee76689cf08c853792ac285e7 (same pin as benchmark/lib/embed.mjs).
Only config.json, model.safetensors and tokenizer.json are fetched, by that
revision -- never `main` -- via huggingface_hub with revision= pinned, so a
mutable HF ref can never silently change these fixtures.

NOTE on max_length: StaticModel.encode() truncates at 512 tokens by default.
src/features/embed.ts's staticProvider never truncates, so encode() is called
here with max_length=None to match the convention actually being pinned (no
special tokens, drop unk ids, mean-pool, L2-normalize -- model2vec/model.py) --
otherwise the long-paragraph fixture would test truncation, a behavior the JS
port was never asked to reproduce.

Regenerate: from a Python 3.10+ venv, `pip install model2vec tokenizers
huggingface_hub`, then `python3 test/fixtures/parity/generate.py`. Only run
this by hand when the model/tokenizer pin changes -- Python never appears in
CI, on user machines, or in this project's dependencies.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from huggingface_hub import snapshot_download
from model2vec import StaticModel
from tokenizers import Tokenizer

import huggingface_hub
import model2vec
import tokenizers as tokenizers_pkg

MODEL_ID = "minishlab/potion-retrieval-32M"
REVISION = "6fc8051fab2a1e0ee76689cf08c853792ac285e7"

LONG_PARAGRAPH = (
    "Long before computers existed, people organized information by hand, and the problems that "
    "motivate modern search were already visible in clay tablets, papyrus scrolls, and the card "
    "catalogs of nineteenth century libraries. A scribe cataloguing a temple archive in Mesopotamia "
    "faced the same basic question a search engine faces today: given a query about the world, "
    "which of the many records on the shelf actually answers it. Early librarians solved this with "
    "controlled vocabularies, subject headings, and physical arrangement, so that a reader who "
    "understood the scheme could walk directly to the right shelf. The scheme worked well for "
    "readers who already knew the vocabulary, and it failed quietly for everyone else, because a "
    "synonym or a foreign phrase simply pointed nowhere.\n\n"
    "The twentieth century brought mechanical and then electronic indexing, and with it the "
    "distinction between literal matching and something closer to meaning. Early information "
    "retrieval systems counted words, built inverted indexes, and ranked documents by how often and "
    "how rarely a term appeared across a collection. This approach, refined over decades into "
    "methods such as term frequency inverse document frequency weighting and later Okapi BM25, is "
    "remarkably effective and still forms the backbone of most production search systems. It has "
    "one deep limitation: it can only find what is written. A query for an apple will not surface a "
    "passage about a pomme unless something bridges the two surface forms, and no amount of clever "
    "weighting fixes a vocabulary mismatch on its own.\n\n"
    "Vector representations of words and sentences were proposed as an answer to exactly this gap. "
    "Instead of representing a document as a bag of discrete tokens, an embedding model maps text "
    "into a continuous space where semantically related passages land near each other, even when "
    "they share no words at all. The idea has a long history in distributional semantics, going "
    "back to the observation that words appearing in similar contexts tend to have similar "
    "meanings, and it was made practical at scale first by neural word embeddings and later by "
    "transformer encoders trained on enormous corpora. Static embeddings, distilled from those "
    "larger encoders into a single lookup table per token, keep most of the benefit while removing "
    "the cost of running a neural network at query time, which matters enormously for a tool meant "
    "to run locally on a laptop rather than in a data center.\n\n"
    "None of this replaces literal search, and treating it as a replacement is a common mistake. A "
    "vector index will happily return a plausible neighbor for almost any query, including queries "
    "in a language or script the model was never trained on, so a system that only reports "
    "similarity scores can look confident while being quietly wrong. The two approaches are "
    "complementary rather than competing: literal search guarantees that an exact phrase, in any "
    "script, can always be found, while semantic search recovers paraphrases, synonyms, and "
    "translations that literal matching structurally cannot reach. A well built retrieval system "
    "therefore treats them as two independent signals to be combined, weighted according to the "
    "evidence from the corpus at hand, rather than as two implementations of the same idea where "
    "one is assumed to be strictly better.\n\n"
    "The parity problem this file exists to address sits underneath both approaches. However good "
    "the algorithm, an implementation is only as trustworthy as its agreement with a reference, and "
    "a port that silently drifts from its source produces plausible looking numbers that are simply "
    "incorrect. Fixed inputs, run once through the original implementation and committed alongside "
    "the port, turn that risk from an assumption into something that can be checked on every run of "
    "the test suite, which is the entire point of an oracle."
)

# (category, text) -- category is documentation only, not part of the fixture schema.
INPUTS = [
    ("plain-english", "The quick brown fox jumps over the lazy dog."),
    ("plain-english", "Semantic search finds what is meant, not just what is written."),
    ("plain-english-question", "Which of these documents talks about apples?"),
    ("empty", ""),
    ("whitespace-only", "   \n\t  \n  "),
    ("single-word", "hello"),
    ("long-paragraph", LONG_PARAGRAPH),
    ("diacritics", "café naïve Zürich"),
    ("chinese", "这是一个测试句子,用于验证语义搜索的中文支持是否正确。"),
    ("japanese", "これはテストです。東京タワーは日本の有名な観光地です。"),
    ("korean", "이것은 테스트 문장입니다. 서울은 대한민국의 수도입니다."),
    ("cyrillic", "Это тестовое предложение на русском языке для проверки поддержки кириллицы."),
    ("arabic", "هذه جملة اختبارية باللغة العربية للتحقق من دعم النص العربي."),
    ("mixed-english-cjk", "The Tokyo office (東京オフィス) opens at 9am."),
    ("emoji", "Great job! 🎉🚀😊 Let's ship it 🔥"),
    ("markdown", "# Heading\n\n**bold** and [a link](https://example.com)\n\n```js\nconst x = 1;\n```"),
    ("punctuation-only", "!?,.;:—()[]{}\"'…"),
    ("french-accented", "L'élève a préféré le café à la bibliothèque."),
    # Rare scripts (Runic, Egyptian hieroglyphs, historical Cyrillic) that this tokenizer's
    # WordPiece vocab has no coverage for at all -- every token comes back [UNK], verified by
    # hand against tokenizer.json before being pinned here.
    ("oov-guaranteed", "ᚠᚢᚦᚨᚱᚲ 𓀀𓀁𓀂 ꙮꙮꙮ"),
    # Contrast case: this WordPiece vocab has byte/char-level coverage of Latin script, so
    # ASCII gibberish decomposes into subword pieces (##x, ##q, ...) rather than [UNK] -- it is
    # NOT out-of-vocabulary, verified by hand against tokenizer.json before being pinned here.
    ("ascii-gibberish-not-oov", "asdkfjqpwoeiruty zxcvbnmqwer plkjhgfdsazxc"),
]


def main() -> None:
    out_dir = Path(__file__).resolve().parent
    snapshot_dir = Path(
        snapshot_download(
            MODEL_ID,
            revision=REVISION,
            allow_patterns=["config.json", "model.safetensors", "tokenizer.json"],
        )
    )

    tokenizer = Tokenizer.from_file(str(snapshot_dir / "tokenizer.json"))
    # A local directory that already exists loads straight from disk (model2vec's
    # _resolve_folder short-circuits on Path.exists()), so this never resolves `main` --
    # it only ever reads the pinned snapshot fetched above.
    model = StaticModel.from_pretrained(str(snapshot_dir))

    cases = []
    for category, text in INPUTS:
        token_ids = tokenizer.encode(text, add_special_tokens=False).ids
        vector = model.encode(text, max_length=None)  # no truncation -- see module docstring

        norm = float(np.linalg.norm(vector))
        is_zero_expected = category in ("empty", "whitespace-only", "oov-guaranteed")
        if is_zero_expected:
            assert norm < 1e-6, f"{category!r}: expected a zero vector, got norm {norm}"
        else:
            assert abs(norm - 1.0) < 1e-4, f"{category!r}: expected L2-normalized output, got norm {norm}"

        cases.append(
            {
                "category": category,
                "input": text,
                "token_ids": [int(i) for i in token_ids],
                "vector": [float(x) for x in vector.tolist()],
            }
        )

    fixtures = {
        "meta": {
            "model": MODEL_ID,
            "revision": REVISION,
            "model2vec_version": model2vec.__version__,
            "tokenizers_version": tokenizers_pkg.__version__,
            "huggingface_hub_version": huggingface_hub.__version__,
            "generated": datetime.now(timezone.utc).isoformat(),
        },
        "cases": cases,
    }

    out_path = out_dir / "fixtures.json"
    out_path.write_text(json.dumps(fixtures, ensure_ascii=False, indent=2))
    size = out_path.stat().st_size
    print(f"wrote {out_path} ({size} bytes, {len(cases)} cases)")


if __name__ == "__main__":
    main()
