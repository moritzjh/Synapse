# Synapse

Notizen + Karteikarten + Wissensgraph – RemNote-artig (Notion + Anki), mit einem Graphen wie in
Obsidian. Ähnliche Inhalte werden von einem **lokalen KI-Modell** automatisch verknüpft.

- **Backend:** C++20 · cpp-httplib · SQLite (WAL + FTS5) · ONNX Runtime · hnswlib (HNSW-Vektorindex) · FSRS-5 · md4c · MCP
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

**Prüfungen** – trage ein, wann du welche Notizen können musst:
- Neue Karten dieser Notizen werden gleichmäßig auf die Tage bis zur Prüfung verteilt (fertig spätestens am Vortag).
- Würde eine Karte erst nach der Prüfung wieder drankommen und wäre die erwartete Erinnerung am Prüfungstag
  < 95 %, wird sie auf den Vortag vorgezogen. Sichere Karten bleiben, wo sie sind.
- Die Übersicht zeigt pro Prüfung die **erwartete Erinnerung am Prüfungstag**, sichere Karten, heutige neue Karten.
- „Lernen“ lässt sich auf eine Prüfung einschränken.

**Markdown-Vault (Obsidian-kompatibel)** – jede Notiz liegt zusätzlich als `.md`-Datei in `vault/`:
- Öffne den Ordner einfach in Obsidian. Änderungen dort (oder in jedem anderen Editor) werden alle 2 s eingelesen,
  Änderungen in Synapse sofort geschrieben.
- Dateiname = Titel, Unterordner bleiben erhalten, Bilder liegen in `vault/attachments/`.
- `synapse-id` im Front-Matter sorgt dafür, dass Umbenennen/Verschieben die Notiz (und ihre Lernhistorie) behält;
  andere Front-Matter-Felder (tags, aliases …) bleiben unangetastet.
- Gelöschte Notizen landen in `vault/.trash/`. Fehlt plötzlich mehr als die Hälfte aller Dateien (z. B. Laufwerk nicht
  eingehängt), wird nichts gelöscht.

**MCP-Server** – alles ist auch für KI-Assistenten (Claude & Co.) als Tool verfügbar, siehe unten.

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
| `SYNAPSE_VAULT`   | Markdown-Ordner (Standard `vault`)                              |
| `SYNAPSE_HOST`    | Bind-Adresse (Standard `127.0.0.1`, nur lokal erreichbar)       |
| `SYNAPSE_STATIC`  | gebautes Frontend ausliefern                                    |

`synapse.json` im Modellordner: `prefix`/`query_prefix` (für e5: `"passage: "`/`"query: "`),
`max_tokens`, `link_threshold` (ab welcher Kosinus-Ähnlichkeit eine Kante entsteht).

## MCP-Server

Der Backend-Prozess spricht das [Model Context Protocol](https://modelcontextprotocol.io) – über HTTP unter
`http://127.0.0.1:8080/mcp` und über stdio mit `synapse mcp` (leitet an das laufende Backend weiter).

**Claude Code**
```bash
claude mcp add --transport http synapse http://127.0.0.1:8080/mcp
```

**Claude Desktop** (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "synapse": { "command": "/pfad/zu/synapse/backend/build/synapse", "args": ["mcp"] }
  }
}
```

| Tool            | Zweck                                                                  |
|-----------------|------------------------------------------------------------------------|
| `list_notes`    | alle Notizen                                                           |
| `read_note`     | Notiz als Markdown + Backlinks + ähnliche Notizen (per id oder Titel)  |
| `search_notes`  | Volltext- und/oder semantische Suche                                   |
| `create_note`   | Notiz aus Markdown anlegen (inkl. Karteikarten-Syntax)                 |
| `update_note`   | ersetzen, anhängen, umbenennen                                         |
| `delete_note`   | löschen (Datei → `.trash`)                                             |
| `get_graph`     | Wissensgraph mit Link- und Ähnlichkeitskanten                          |
| `list_cards`    | Karteikarten einer Notiz                                               |
| `review_queue`  | fällige Karten (optional pro Prüfung) – z. B. um dich abzufragen       |
| `review_card`   | Bewertung 1–4 eintragen                                                |
| `list_exams` / `create_exam` / `update_exam` / `delete_exam` | Prüfungen verwalten       |

Beispiel: *„Lies meine Notizen zur Zellbiologie, erstelle Karteikarten für alles Wichtige und lege eine Prüfung
für den 14. Februar an.“*

## Architektur

```
React (TipTap-JSON) ──HTTP/JSON──▶ C++ Backend ◀── MCP (HTTP /mcp, stdio) ── Claude & Co.
                                    ├─ Service       gemeinsame Logik für REST und MCP
                                    ├─ NoteStore     SQLite: notes, wikilinks, cards, review_log, exams, embeddings
                                    ├─ Vault         .md-Dateien ⇄ Notizen (md4c-Parser, Polling, Rename-Erkennung)
                                    │                content.cpp: JSON → Text, Karten-Erkennung
                                    ├─ SemanticIndex Hintergrund-Thread, entprellt (1,5 s nach letzter Änderung)
                                    │   ├─ Tokenizer  WordPiece + Unigram aus tokenizer.json (eigene Impl.)
                                    │   ├─ Embedder   ONNX Runtime, Mean-Pooling, L2-Norm
                                    │   └─ HNSW       hnswlib, Kosinus über Inner Product
                                    └─ FSRS-5        Scheduler für Karteikarten, prüfungsbewusst
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
| GET/POST/PUT/DELETE | `/api/exams[/:id]` | Prüfungen inkl. Fortschritt                 |
| GET     | `/api/review/queue?exam=`    | Lern-Warteschlange einer Prüfung            |
| GET     | `/api/status`                | Modell, Anzahl indexierter Notizen, Vault   |
| POST    | `/mcp`                       | MCP (JSON-RPC)                              |

## Roadmap

1. ✅ Fundament: Notizen, `[[Wikilinks]]`, Backlinks, Volltextsuche, Graph
2. ✅ Lokales Embedding-Modell in C++, HNSW, automatische semantische Kanten
3. ✅ Karteikarten (Basic, Reverse, Listen, Lückentext) mit FSRS
4. ✅ Notion-artiger Editor (Tabellen, Code, Bilder, Diagramme, Slash-Menü)
5. ✅ Prüfungs-Planung, Obsidian-Vault, MCP-Server, minimalistisches UI
6. ⬜ Image Occlusion (Bildbereiche abdecken), Karten mit Formatierung/Bildern
7. ⬜ Block-Ebene: Embeddings pro Absatz, Block-Referenzen, Ordner/Hierarchie
8. ⬜ Automatische Begriffserkennung + Karten-Vorschläge, Freihand-Zeichnungen
