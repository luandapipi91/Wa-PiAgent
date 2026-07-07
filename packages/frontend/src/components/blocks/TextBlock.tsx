import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props { text: string; }

export function TextBlock({ text }: Props) {
  return (
    <div className="text-sm prose prose-invert max-w-none" data-testid="text-block">
      <ReactMarkdown remarkGfm={remarkGfm}>{text}</ReactMarkdown>
    </div>
  );
}
