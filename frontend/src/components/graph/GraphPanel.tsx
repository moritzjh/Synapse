import { useState } from 'react'
import { Icon } from '../Icons'
import { DEFAULTS, PRESETS, type Group, type Settings, type StyleName } from './settings'

interface Props {
  settings: Settings
  series: string[]
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  replace: (s: Settings) => void
  onClose: () => void
}

const OPEN_KEY = 'synapse.graph.sections'

function loadOpen(): Record<string, boolean> {
  try {
    return { style: true, filter: true, ...JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') }
  } catch {
    return { style: true, filter: true }
  }
}

export default function GraphPanel({ settings: s, series, set, replace, onClose }: Props) {
  const [open, setOpen] = useState(loadOpen)
  const toggle = (k: string) =>
    setOpen((o) => {
      const n = { ...o, [k]: !o[k] }
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(n))
      } catch {
        /* ignore */
      }
      return n
    })

  // called as a function (not <Section/>) so inputs inside keep their focus across renders
  const Section = (p: { id: string; title: string; children: React.ReactNode }) => (
    <SectionBox key={p.id} {...p} open={!!open[p.id]} onToggle={() => toggle(p.id)} />
  )

  const setGroups = (fn: (g: Group[]) => Group[]) => set('groups', fn(s.groups))

  return (
    <div className="gp">
      <header className="gp-top">
        <span>Graph</span>
        <button className="icon-btn" title="Alles zurücksetzen" onClick={() => replace(DEFAULTS)}>
          <Icon name="reset" />
        </button>
        <button className="icon-btn" title="Schließen" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      {Section({ id: "style", title: "Stil", children: (<>
        <div className="gp-presets">
          {(Object.keys(PRESETS) as StyleName[]).map((k) => (
            <button
              key={k}
              className={`gp-preset preset-${k} ${s.style === k ? 'on' : ''}`}
              onClick={() => replace({ ...s, ...PRESETS[k].apply })}
              title={PRESETS[k].hint}
            >
              <span className="gp-swatch">
                <i /><i /><i /><b /><b />
              </span>
              {PRESETS[k].name}
            </button>
          ))}
        </div>
        <Slider label="Leuchten" value={s.glow} min={0} max={1} step={0.05} fmt={pct} set={(v) => set('glow', v)} />
        <Row label="Hintergrund">
          <Segmented
            value={s.background}
            options={[['none', 'Ohne'], ['dots', 'Raster'], ['stars', 'Sterne']]}
            set={(v) => set('background', v as Settings['background'])}
          />
        </Row>
        <Toggle label="Signalfluss beim Zeigen" on={s.particles} set={(v) => set('particles', v)} />
      </>) })}

      {Section({ id: "filter", title: "Filter", children: (<>
        <Toggle label="Verlinkungen" on={s.links} set={(v) => set('links', v)} />
        <Toggle label="Unterseiten" on={s.subpages} set={(v) => set('subpages', v)} />
        <Toggle label="Ähnlicher Inhalt" on={s.semantic} set={(v) => set('semantic', v)} />
        {s.semantic && (
          <Slider label="ab Ähnlichkeit" value={s.minSimilarity} min={0} max={0.95} step={0.05} fmt={pct} set={(v) => set('minSimilarity', v)} />
        )}
        <Toggle label="Notizen ohne Verbindung" on={s.orphans} set={(v) => set('orphans', v)} />
      </>) })}

      {Section({ id: "groups", title: "Gruppen", children: (<>
        <Toggle label="Automatisch nach Ordner" on={s.autoGroups} set={(v) => set('autoGroups', v)} />
        {s.autoGroups && (
          <Row label="Ebene">
            <Segmented
              value={String(s.colorDepth)}
              options={[['0', 'Auto'], ['1', 'Oberste'], ['2', 'Unterordner']]}
              set={(v) => set('colorDepth', Number(v) as 0 | 1 | 2)}
            />
          </Row>
        )}
        {s.groups.map((g) => (
          <GroupRow
            key={g.id}
            group={g}
            series={series}
            change={(ng) => setGroups((gs) => gs.map((x) => (x.id === g.id ? ng : x)))}
            remove={() => setGroups((gs) => gs.filter((x) => x.id !== g.id))}
          />
        ))}
        <button
          className="gp-add"
          onClick={() => setGroups((gs) => [...gs, { id: Math.random().toString(36).slice(2, 9), query: '', color: gs.length % 8 }])}
        >
          <Icon name="plus" /> Neue Gruppe
        </button>
        <p className="gp-note">Eigene Gruppen gehen vor. Suche nach Titel, oder <code>path:Uni/Bio</code> · <code>title:Mitose</code></p>
      </>) })}

      {Section({ id: "display", title: "Anzeige", children: (<>
        <Row label="Beschriftung">
          <Segmented
            value={s.labels}
            options={[['auto', 'Auto'], ['always', 'Immer'], ['hover', 'Zeigen']]}
            set={(v) => set('labels', v as Settings['labels'])}
          />
        </Row>
        {s.labels === 'auto' && (
          <Slider label="Text einblenden ab Zoom" value={s.textFade} min={0} max={1} step={0.05} fmt={(v) => `${(0.3 + v * 2).toFixed(1)}×`} set={(v) => set('textFade', v)} />
        )}
        <Slider label="Knotengröße" value={s.nodeSize} min={0.4} max={2.5} step={0.1} fmt={(v) => `${v.toFixed(1)}×`} set={(v) => set('nodeSize', v)} />
        <Slider label="Linkstärke" value={s.linkWidth} min={0.3} max={3} step={0.1} fmt={(v) => `${v.toFixed(1)}×`} set={(v) => set('linkWidth', v)} />
        <Toggle label="Pfeile" on={s.arrows} set={(v) => set('arrows', v)} />
      </>) })}

      {Section({ id: "forces", title: "Kräfte", children: (<>
        <Slider label="Zentrierung" value={s.center} min={0} max={0.4} step={0.01} fmt={(v) => v.toFixed(2)} set={(v) => set('center', v)} />
        <Slider label="Abstoßung" value={s.repel} min={10} max={800} step={10} fmt={String} set={(v) => set('repel', v)} />
        <Slider label="Linkkraft" value={s.linkForce} min={0.05} max={1} step={0.05} fmt={(v) => v.toFixed(2)} set={(v) => set('linkForce', v)} />
        <Slider label="Linkabstand" value={s.distance} min={10} max={250} step={5} fmt={String} set={(v) => set('distance', v)} />
      </>) })}
    </div>
  )
}

const pct = (v: number) => `${Math.round(v * 100)}%`

function SectionBox({ title, open, onToggle, children }: { id: string; title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section className={`gp-section ${open ? 'open' : ''}`}>
      <button className="gp-head" onClick={onToggle}>
        <Icon name="chevron" />
        {title}
      </button>
      {open && <div className="gp-body">{children}</div>}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="gp-row">
      <span>{label}</span>
      {children}
    </div>
  )
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="gp-row clickable">
      <span>{label}</span>
      <input type="checkbox" className="switch" checked={on} onChange={(e) => set(e.target.checked)} />
    </label>
  )
}

function Slider(p: { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; set: (v: number) => void }) {
  const fill = ((p.value - p.min) / (p.max - p.min)) * 100
  return (
    <label className="gp-slider">
      <span className="gp-slider-head">
        {p.label}
        <b>{p.fmt(p.value)}</b>
      </span>
      <input
        type="range"
        min={p.min}
        max={p.max}
        step={p.step}
        value={p.value}
        style={{ '--fill': `${fill}%` } as React.CSSProperties}
        onChange={(e) => p.set(Number(e.target.value))}
      />
    </label>
  )
}

function Segmented({ value, options, set }: { value: string; options: [string, string][]; set: (v: string) => void }) {
  return (
    <span className="gp-seg">
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => set(v)}>
          {label}
        </button>
      ))}
    </span>
  )
}

function GroupRow({ group, series, change, remove }: { group: Group; series: string[]; change: (g: Group) => void; remove: () => void }) {
  const [picking, setPicking] = useState(false)
  return (
    <div className="gp-group">
      <button className="gp-color" style={{ background: series[group.color] }} onClick={() => setPicking((p) => !p)} title="Farbe" />
      <input value={group.query} placeholder="Suchbegriff oder path:…" onChange={(e) => change({ ...group, query: e.target.value })} />
      <button className="icon-btn" onClick={remove} title="Gruppe entfernen">
        <Icon name="x" />
      </button>
      {picking && (
        <div className="gp-colors">
          {series.map((c, i) => (
            <button
              key={i}
              style={{ background: c }}
              className={i === group.color ? 'on' : ''}
              onClick={() => {
                change({ ...group, color: i })
                setPicking(false)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
