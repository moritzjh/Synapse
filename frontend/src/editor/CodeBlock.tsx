import { useMemo, useState } from 'react'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { common, createLowlight } from 'lowlight'

export const lowlight = createLowlight(common)

/** Shown in the picker; everything else lowlight knows still highlights when set in Markdown. */
const LANGUAGES: [string, string][] = [
  ['python', 'Python'],
  ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['java', 'Java'],
  ['cpp', 'C++'],
  ['c', 'C'],
  ['csharp', 'C#'],
  ['go', 'Go'],
  ['rust', 'Rust'],
  ['kotlin', 'Kotlin'],
  ['swift', 'Swift'],
  ['php', 'PHP'],
  ['ruby', 'Ruby'],
  ['r', 'R'],
  ['sql', 'SQL'],
  ['bash', 'Bash'],
  ['json', 'JSON'],
  ['yaml', 'YAML'],
  ['xml', 'HTML/XML'],
  ['css', 'CSS'],
  ['markdown', 'Markdown'],
  ['plaintext', 'Text'],
]
const LABEL = Object.fromEntries(LANGUAGES)
const AUTO_SUBSET = LANGUAGES.map(([id]) => id).filter((id) => id !== 'plaintext')

/** Best guess for a snippet, or null when lowlight is not confident. */
export function detectLanguage(code: string): string | null {
  if (code.trim().length < 12) return null
  const r = lowlight.highlightAuto(code, { subset: AUTO_SUBSET })
  const lang = r.data?.language
  return lang && (r.data?.relevance ?? 0) >= 4 ? lang : null
}

function CodeBlockView({ node, updateAttributes }: ReactNodeViewProps) {
  const language: string | null = node.attrs.language
  const [copied, setCopied] = useState(false)
  const text = node.textContent
  const detected = useMemo(() => (language ? null : detectLanguage(text)), [language, text])
  const shown = language ?? detected

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <NodeViewWrapper className="code-block">
      <div className="code-bar" contentEditable={false}>
        <select
          className="code-lang"
          value={language ?? ''}
          onChange={(e) => updateAttributes({ language: e.target.value || null })}
          title="Sprache"
        >
          <option value="">{detected ? `Auto · ${LABEL[detected] ?? detected}` : 'Auto'}</option>
          {LANGUAGES.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
          {language && !LABEL[language] && <option value={language}>{language}</option>}
        </select>
        <button className="code-copy" onClick={copy} title="Code kopieren">
          {copied ? 'Kopiert' : 'Kopieren'}
        </button>
      </div>
      <pre className={shown ? `language-${shown}` : undefined}>
        <NodeViewContent<'code'> as="code" />
      </pre>
    </NodeViewWrapper>
  )
}

const CODE_LINE =
  /^\s*(def |class |import |from \S+ import|return\b|if .*:$|elif |else:|for .*:$|while .*:$|try:|except|with .*:$|print\(|const |let |var |function |#include|public |private |static |using |namespace |SELECT |INSERT |CREATE |fn |func |package |@\w+)/

/** Plain text that is clearly source code (copied from an IDE, a terminal, …). */
export function looksLikeCode(text: string): boolean {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim())
  if (lines.length < 2) return false
  let signals = 0
  for (const l of lines) {
    if (/^( {2,}|\t)\S/.test(l)) signals++
    else if (CODE_LINE.test(l)) signals++
    else if (/[{};]\s*$|^\s*[})\]]/.test(l)) signals++
    else if (/\w\(.*\)|\s=\s|==|!=|=>|->/.test(l) && !/[.!?]\s*$/.test(l)) signals += 0.5
  }
  return signals >= 2 && signals / lines.length >= 0.5
}

/**
 * Code block with a language picker (auto-detected by default), a copy
 * button, Tab indentation, and pasting of plain-text code into a new block
 * instead of a pile of paragraphs that lose their indentation.
 */
export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView)
  },
  addProseMirrorPlugins() {
    const type = this.type
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: new PluginKey('codePaste'),
        props: {
          handlePaste: (view, event) => {
            const data = event.clipboardData
            if (!data) return false
            const text = data.getData('text/plain')
            const fromIde = !!data.getData('vscode-editor-data')
            // HTML from web pages keeps its own <pre> blocks; IDEs send HTML too, but it is just styled text.
            if (!text || (data.getData('text/html') && !fromIde)) return false
            const { $from } = view.state.selection
            if ($from.parent.type.spec.code) return false
            if (!fromIde && !looksLikeCode(text)) return false
            const code = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
            const vscodeLang = fromIde ? (JSON.parse(data.getData('vscode-editor-data')).mode as string | undefined) : undefined
            const language = vscodeLang && lowlight.registered(vscodeLang) ? vscodeLang : detectLanguage(code)
            const node = type.create({ language }, view.state.schema.text(code))
            view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView())
            return true
          },
        },
      }),
    ]
  },
}).configure({ lowlight, defaultLanguage: null, enableTabIndentation: true, tabSize: 4 })
