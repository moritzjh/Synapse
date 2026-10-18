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
}

export type IconName = keyof typeof paths

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  )
}
