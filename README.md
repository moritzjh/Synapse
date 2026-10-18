# Synapse

Notizen + Karteikarten + Wissensgraph – RemNote-artig (Notion + Anki), mit einem Graphen wie in
Obsidian. Ähnliche Inhalte werden von einem **lokalen KI-Modell** automatisch verknüpft.

- **Backend:** C++20 · cpp-httplib · SQLite (WAL + FTS5) · ONNX Runtime · hnswlib (HNSW-Vektorindex) · FSRS-5
- **Frontend:** React 19 · TypeScript · Vite · TipTap (ProseMirror) · Mermaid · react-force-graph

## Features

**Notizen (Notion-Stil)**
- Fett, kursiv, unterstrichen, durchgestrichen, Markieren, Inline-Code, Überschriften
- Listen, To-dos, Zitate, Trennlinien, Tabellen (Zeilen/Spalten hinzufügen, Breite ziehen)
- Codeblöcke mit Syntax-Highlighting
- Bilder: Button, Einfügen aus der Zwischenablage oder Drag & Drop (Upload ins Backend)
- Diagramme/Grafiken mit [Mermaid](https://mermaid.js.org) (Flowchart, Sequenz, Mindmap, Pie, Gantt …)
- `/` öffnet das Befehlsmenü, `[[` vervollständigt Links zu anderen Notizen

**Verknüpfung**
- `[[Notiz]]`-Links + Backlinks, Volltextsuche (FTS5, BM25)
- Jede Notiz wird lokal eingebettet (Embedding); per HNSW-Index werden ähnliche Notizen gefunden und als
  gestrichelte Kanten in den Graphen eingetragen – ohne dass du etwas verlinken musst
- „Ähnliche Notizen“-Leiste neben dem Editor, semantische Suche (`/api/semantic-search`)

**Karteikarten (RemNote-Stil)** – entstehen direkt aus dem Notiztext:

| Schreibweise                         | Karte                                                  |
|--------------------------------------|--------------------------------------------------------|
| `Frage >> Antwort`                   | Vorderseite → Rückseite                                |
| `Begriff :: Definition`              | zwei Karten (vorwärts + rückwärts)                     |
| `Frage >>` + Aufzählung darunter     | Listen-Karte: Punkte werden **einzeln aufgedeckt**     |
| `Die {{Mitochondrien}} sind …`       | Lückentext: jede Lücke ist **abgedeckt** und einzeln aufdeckbar |

Gelernt wird mit dem FSRS-5-Algorithmus (wie im modernen Anki): Nochmal / Schwer / Gut / Einfach, Tasten
`Leertaste` (aufdecken) und `1`–`4`. 20 neue Karten pro Tag.

## Einrichtung

Voraussetzungen: CMake ≥ 3.20, ein C++20-Compiler, SQLite3-Header (`libsqlite3-dev` / `brew install sqlite`),
Node.js ≥ 20.

```bash
# 1. ONNX Runtime holen (Linux/macOS, x64/arm64)
./scripts/setup_onnxruntime.sh

# 2. Embedding-Modell laden
./scripts/download_model.sh          # multilingual-e5-small – Deutsch, Englisch, … (empfohlen)
./scripts/download_model.sh minilm   # all-MiniLM-L6-v2 – kleiner, nur Englisch

# 3. Backend bauen + testen
cd backend
cmake -S . -B build -G Ninja && cmake --build build
./build/synapse_tests

# 4. Backend starten (Port 8080)
SYNAPSE_MODEL=../models/multilingual-e5-small ./build/synapse synapse.db

# 5. Frontend (Dev-Server mit Proxy auf :8080)
cd ../frontend && npm install && npm run dev
```

Production: `npm run build`, dann `SYNAPSE_STATIC=../frontend/dist ./build/synapse` – das Backend liefert
das Frontend selbst aus.

| Umgebungsvariable | Bedeutung                                                       |
|-------------------|-----------------------------------------------------------------|
| `PORT`            | HTTP-Port (Standard 8080)                                       |
| `SYNAPSE_MODEL`   | Modellordner (`model.onnx`, `tokenizer.json`, `synapse.json`); ohne → keine Auto-Links |
| `SYNAPSE_UPLOADS` | Ordner für hochgeladene Bilder (Standard `uploads`)             |
| `SYNAPSE_STATIC`  | gebautes Frontend ausliefern                                    |

`synapse.json` im Modellordner: `prefix`/`query_prefix` (für e5: `"passage: "`/`"query: "`),
`max_tokens`, `link_threshold` (ab welcher Kosinus-Ähnlichkeit eine Kante entsteht).

## Architektur

```
React (TipTap-JSON) ──HTTP/JSON──▶ C++ Backend
                                    ├─ NoteStore     SQLite: notes, wikilinks, cards, review_log, embeddings
                                    │                content.cpp: JSON → Text, Karten-Erkennung
                                    ├─ SemanticIndex Hintergrund-Thread, entprellt (1,5 s nach letzter Änderung)
                                    │   ├─ Tokenizer  WordPiece + Unigram aus tokenizer.json (eigene Impl.)
                                    │   ├─ Embedder   ONNX Runtime, Mean-Pooling, L2-Norm
                                    │   └─ HNSW       hnswlib, Kosinus über Inner Product
                                    └─ FSRS-5        Scheduler für Karteikarten
```

Gemessen (all-MiniLM-L6-v2, 2 Threads): Volltextsuche ≈ 0,8 ms, semantische Suche inkl. Einbetten der
Anfrage ≈ 3,4 ms, Einbetten einer langen Notiz (~1400 Tokens) ≈ 45 ms. C++-Tokenizer und Embeddings sind
gegen die HuggingFace-Referenz geprüft (identische Token-IDs, identische Kosinuswerte).

## API

| Methode | Pfad                         | Zweck                                       |
|---------|------------------------------|---------------------------------------------|
| GET     | `/api/notes`                 | Alle Notizen (ohne Inhalt)                  |
| GET/PUT/DELETE | `/api/notes/:id`      | Notiz lesen / speichern / löschen           |
| POST    | `/api/notes`                 | `{title, content}` anlegen (content = TipTap-JSON oder Text) |
| GET     | `/api/notes/:id/backlinks`   | Notizen, die hierher verlinken              |
| GET     | `/api/notes/:id/similar`     | semantisch ähnliche Notizen                 |
| GET     | `/api/notes/:id/cards`       | Karteikarten dieser Notiz                   |
| GET     | `/api/search?q=`             | Volltextsuche                               |
| GET     | `/api/semantic-search?q=`    | Suche nach Bedeutung                        |
| GET     | `/api/graph`                 | Knoten + Kanten (`link` / `semantic`)       |
| GET     | `/api/review/queue`          | fällige + neue Karten inkl. Intervall-Vorschau |
| GET     | `/api/review/stats`          | fällig / neu / heute gelernt                |
| POST    | `/api/cards/:id/review`      | `{rating: 1..4}`                            |
| POST    | `/api/uploads`               | Bild-Upload (multipart `file`)              |
| GET     | `/api/status`                | Modell, Anzahl indexierter Notizen          |

## Roadmap

1. ✅ Fundament: Notizen, `[[Wikilinks]]`, Backlinks, Volltextsuche, Graph
2. ✅ Lokales Embedding-Modell in C++, HNSW, automatische semantische Kanten
3. ✅ Karteikarten (Basic, Reverse, Listen, Lückentext) mit FSRS
4. ✅ Notion-artiger Editor (Tabellen, Code, Bilder, Diagramme, Slash-Menü)
5. ⬜ Image Occlusion (Bildbereiche abdecken), Karten mit Formatierung/Bildern
6. ⬜ Block-Ebene: Embeddings pro Absatz, Block-Referenzen, Ordner/Hierarchie
7. ⬜ Automatische Begriffserkennung + Karten-Vorschläge, Freihand-Zeichnungen
