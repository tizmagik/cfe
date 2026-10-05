import { searchQA } from './qa.js';
import { lexicalQA, topicsQA } from './qa-lexical.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/deployment") {
      return Response.json(
        { commit: env.DEPLOYMENT_SHA },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // Preserve the current canonical hostname without redirecting PR previews.
    if (url.hostname === "christforeveryone.org") {
      url.hostname = "www.christforeveryone.org";
      return Response.redirect(url.toString(), 301);
    }
    let response;
    if (url.pathname === '/qa') {
      url.pathname = '/qa/';
      response = Response.redirect(url.toString(), 308);
    } else {
      response = url.pathname === '/api/qa/lexical'
      ? await lexicalQA(request, env)
      : url.pathname === '/api/qa/topics'
        ? await topicsQA(request, env)
      : url.pathname === '/api/qa/search'
      ? await searchQA(request, env)
      : url.pathname.startsWith('/api/')
        ? Response.json({ error: 'Not found' }, { status: 404 })
        : await env.ASSETS.fetch(request);
    }
    if (/^pr-[1-9]\d*\.christforeveryone\.org$/.test(url.hostname)) {
      const preview = new Response(response.body, response);
      preview.headers.set("X-Robots-Tag", "noindex, nofollow");
      return preview;
    }
    return response;
  },
};
