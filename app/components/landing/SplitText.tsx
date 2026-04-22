"use client";

export function SplitWords({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  return (
    <>
      {text.split(" ").map((word, i) => (
        <span key={i} className="split-word-wrapper">
          <span className={`split-word ${className}`}>{word}</span>
        </span>
      ))}
    </>
  );
}
