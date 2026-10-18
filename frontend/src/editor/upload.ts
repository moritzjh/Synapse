import type { Editor } from '@tiptap/core'

export async function uploadImage(file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/uploads', { method: 'POST', body: form })
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()).url
}

export async function insertImages(editor: Editor, files: File[], pos?: number) {
  for (const file of files.filter((f) => f.type.startsWith('image/'))) {
    const src = await uploadImage(file)
    const chain = editor.chain().focus()
    if (pos !== undefined) chain.insertContentAt(pos, { type: 'image', attrs: { src, alt: file.name } })
    else chain.setImage({ src, alt: file.name })
    chain.run()
  }
}

export function pickImages(editor: Editor) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.onchange = () => insertImages(editor, [...(input.files ?? [])])
  input.click()
}
