/* Shared URL parsing for the editor, player, imports and API validation. */
(function(root){
  'use strict';
  function parse(value) {
    if(typeof value !== 'string' || value.length > 2048) return null;
    let url; try { url = new URL(value.trim()); } catch { return null; }
    if(url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./,'');
    let id;
    if(host === 'youtu.be') id = url.pathname.slice(1);
    if(['youtube.com','m.youtube.com','youtube-nocookie.com'].includes(host)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)\/?$/)?.[1];
    }
    if(id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return {provider:'youtube',url:'https://www.youtube.com/watch?v='+id,embed:'https://www.youtube-nocookie.com/embed/'+id+'?playsinline=1&rel=0&autoplay=1&mute=1&loop=1&playlist='+id+''};
    if(host === 'vimeo.com' || host === 'player.vimeo.com') {
      const match = url.pathname.match(/^\/(?:video\/)?([0-9]{1,12})(?:\/([a-zA-Z0-9]{6,64}))?\/?$/);
      if(match) {
        const h = match[2] || url.searchParams.get('h');
        if(h && !/^[a-zA-Z0-9]{6,64}$/.test(h)) return null;
        return {provider:'vimeo',url:'https://vimeo.com/'+match[1]+(h?'/'+h:''),embed:'https://player.vimeo.com/video/'+match[1]+'?autoplay=1&muted=1&loop=1&playsinline=1'+(h?'&h='+h:'')};
      }
    }
    return null;
  }
  const api={parse,isLink:value=>!!parse(value)};
  if(typeof module === 'object') module.exports=api; else root.VideoSources=api;
})(typeof window === 'undefined' ? globalThis : window);
