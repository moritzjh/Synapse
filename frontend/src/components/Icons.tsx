const paths = {
  search: 'M11 11l3.5 3.5M7 12.5A5.5 5.5 0 1 0 7 1.5a5.5 5.5 0 0 0 0 11z',
  graph: 'M4 4.5a1.75 1.75 0 1 0 0-.01M12 3a1.75 1.75 0 1 0 0-.01M10 13a1.75 1.75 0 1 0 0-.01M5.6 4.8l4.6 6.9M5.7 4.1l4.6-.8M11.6 4.7l-1.2 6.6',
  cards: 'M3 4.5h8.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM4.5 2h9a1 1 0 0 1 1 1v8',
  calendar: 'M3 3.5h10a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1zM2 7h12M5.5 2v3M10.5 2v3',
  plus: 'M8 3v10M3 8h10',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1',
  back: 'M10 4L6 8l4 4',
  spark: 'M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2',
  note: 'M4 2h5.5L12 4.5V14H4zM9 2v3h3',
  edit: 'M10.5 3l2.5 2.5L6 12.5H3.5V10z',
  chevron: 'M6 4l4 4-4 4',
  folder: 'M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  code: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5',
  sliders: 'M3 4h6M12 4h1M3 8h1M7 8h6M3 12h7M13 12h0M10.5 2.5v3M5.5 6.5v3M11.5 10.5v3',
  target: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  x: 'M4 4l8 8M12 4l-8 8',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10 6.5h.01',
  title: 'M3 4h10M8 4v9',
  text: 'M3 4.5h10M3 8h10M3 11.5h6',
  hash: 'M6 3l-1.5 10M11.5 3L10 13M3 6h10M2.5 10h10',
  select: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM5.5 7l2.5 2.5L10.5 7',
  multi: 'M2.5 4h2M2.5 8h2M2.5 12h2M7 4h6.5M7 8h6.5M7 12h6.5',
  status: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 2.5v5.5h5.5',
  check: 'M3 2.5h10a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5zM5 8l2 2 4-4',
  formula: 'M10.5 3H8.5a1.5 1.5 0 0 0-1.5 1.5V12a1.5 1.5 0 0 1-1.5 1.5h-1M5 7.5h5',
  table: 'M2.5 3h11v10h-11zM2.5 6.5h11M2.5 10h11M6.5 6.5V13',
  board: 'M2.5 3h3v9h-3zM6.5 3h3v6h-3zM10.5 3h3v10h-3z',
  chart: 'M8 13.5a5.5 5.5 0 1 1 5.5-5.5H8z',
  reset: 'M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.5h2.5',
  play: 'M5 3.5v9l7-4.5z',
  fit: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10',
}

export type IconName = keyof typeof paths

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  )
}
