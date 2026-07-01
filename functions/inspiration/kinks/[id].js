export async function onRequestGet({ params, request }) {
  const url = new URL(request.url);
  url.pathname = "/inspiration/kink";
  url.search = `?id=${encodeURIComponent(String(params.id || ""))}`;
  return Response.redirect(url.toString(), 302);
}
