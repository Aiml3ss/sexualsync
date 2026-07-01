export async function onRequestGet({ params, request }) {
  return redirectToKink(params.id, request.url);
}

function redirectToKink(id, requestUrl) {
  const url = new URL(requestUrl);
  url.pathname = "/inspiration/kink";
  url.search = `?id=${encodeURIComponent(String(id || ""))}`;
  return Response.redirect(url.toString(), 302);
}
