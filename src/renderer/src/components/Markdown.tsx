// src/renderer/src/components/Markdown.tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { call } from '../api'

export function Markdown({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 [&_:is(h1,h2,h3,h4)]:m-0 [&_:is(h1,h2,h3,h4)]:font-bold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:m-0 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                // 不在 app 視窗裡導覽；https 連結由主程序交給系統瀏覽器
                e.preventDefault()
                if (href) void call('shell:openExternal', href)
              }}
            >
              {children}
            </a>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-xl bg-code p-3 text-[12.5px] text-code-ink [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-code-ink">
              {children}
            </pre>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
