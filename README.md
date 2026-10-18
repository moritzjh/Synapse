# Synapse

Notizen + Karteikarten + Wissensgraph: RemNote-artig (Notion + Anki), mit einem Graphen wie
in Obsidian. Ähnliche Inhalte werden automatisch verknüpft.

- **Backend:** C++20, [cpp-httplib](https://github.com/yhirose/cpp-httplib), SQLite (WAL + FTS5), nlohmann/json
- **Frontend:** React 19 + TypeScript + Vite, `react-force-graph-2d`

## Starten

```bash
# Backend (Port 8080, DB-Datei als Argument)
cd backend
cmake -S . -B build -G Ninja && cmake --build build
./build/synapse synapse.db

# Frontend (Dev-Server mit Proxy auf /api → :8080)
cd frontend
npm install
npm run dev
```

Production: `npm run build`, dann `SYNAPSE_STATIC=../frontend/dist ./build/synapse` – das Backend
liefert das Frontend selbst aus.

## API

| Methode | Pfad                         | Zweck                              |
|---------|------------------------------|------------------------------------|
| GET     | `/api/notes`                 | Alle Notizen (ohne Inhalt)         |
| GET     | `/api/notes/:id`             | Eine Notiz                         |
| POST    | `/api/notes`                 | `{title, content}` anlegen         |
| PUT     | `/api/notes/:id`             | Aktualisieren                      |
| DELETE  | `/api/notes/:id`             | Löschen                            |
| GET     | `/api/notes/:id/backlinks`   | Notizen, die hierher verlinken     |
| GET     | `/api/search?q=`             | Volltextsuche (FTS5, Präfix, BM25) |
| GET     | `/api/graph`                 | Knoten + Kanten für den Graphen    |

## Roadmap

1. ✅ **Fundament:** Notizen-CRUD, `[[Wikilinks]]`, Backlinks, Volltextsuche, Graph-Ansicht
2. ⬜ **Semantische Auto-Links:** Embeddings je Notiz/Absatz, Vektorindex (HNSW) in C++,
   Kanten vom Typ `semantic` ab einem Ähnlichkeitsschwellwert
3. ⬜ **Karteikarten:** `Frage :: Antwort` / `>>`-Syntax in Notizen, Spaced Repetition (FSRS), Review-Modus
4. ⬜ **Block-Editor:** Notion/RemNote-artige Blöcke (Outliner, Markdown-Rendering, Slash-Commands)
5. ⬜ **Automatische Inhaltserkennung:** Entitäten/Begriffe erkennen, Karten-Vorschläge
