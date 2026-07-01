import { redirect } from "next/navigation";

export const runtime = "edge";

export default function LegacyIdeaDetail({
  params,
}: {
  params: { id: string };
}) {
  redirect(`/inspiration/kink?id=${encodeURIComponent(params.id)}`);
}
