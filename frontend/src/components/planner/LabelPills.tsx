import type { Label } from "../../api";

/** A meal's labels, after its title. An unlabelled meal gets nothing at all. */
export function LabelPills({ labels }: { labels: Label[] }) {
  if (labels.length === 0) return null;
  return (
    <ul className="label-pills" aria-label="Labels">
      {labels.map((l) => (
        <li key={l.id}>{l.name}</li>
      ))}
    </ul>
  );
}
