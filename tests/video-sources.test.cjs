const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const sources=require('../video-sources.js');
test('YouTube watch, shortened, shorts and embed links use a trusted embed host',()=>{for(const value of ['https://youtu.be/dQw4w9WgXcQ?t=20','https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=abc','https://youtube.com/shorts/dQw4w9WgXcQ','https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ']){const result=sources.parse(value);assert.equal(result.url,'https://www.youtube.com/watch?v=dQw4w9WgXcQ');assert.match(result.embed,/^https:\/\/www.youtube-nocookie.com\/embed\//);}});
test('Vimeo public and unlisted links retain the privacy hash',()=>{assert.equal(sources.parse('https://vimeo.com/123456').embed,'https://player.vimeo.com/video/123456?autoplay=1&muted=1&loop=1&playsinline=1');assert.equal(sources.parse('https://vimeo.com/123456/abcdef1234').embed,'https://player.vimeo.com/video/123456?autoplay=1&muted=1&loop=1&playsinline=1&h=abcdef1234');assert.equal(sources.parse('https://player.vimeo.com/video/123456?h=abcdef1234').url,'https://vimeo.com/123456/abcdef1234');});
test('Reject arbitrary embeds, scripts, spoofed domains, credentials and malformed IDs',()=>{for(const value of ['javascript:alert(1)','http://youtube.com/watch?v=dQw4w9WgXcQ','https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ','https://evil.example/12345','https://me@vimeo.com/12345','https://youtube.com/watch?v=bad','https://vimeo.com/channels/1234','https://vimeo.com:444/1234'])assert.equal(sources.parse(value),null);});
test('Concurrent library conflicts preserve provider links and remap only uploaded videos',()=>{
 const context={window:{},structuredClone,crypto:require('node:crypto').webcrypto};vm.runInNewContext(fs.readFileSync(require.resolve('../sync-merge.js'),'utf8'),context);
 const pack=name=>({version:2,profiles:[{id:'default',name:'Mine',videos:[],workouts:[{id:'one',name,sets:[{id:'link',video:'https://vimeo.com/123456'}]}]}]});
 const merged=context.window.mergeLibraries(pack('base'),pack('local'),pack('remote'));
 assert.equal(merged.profiles[0].workouts.length,2);assert.equal(merged.profiles[0].workouts[1].sets[0].video,'https://vimeo.com/123456');assert.notEqual(merged.profiles[0].workouts[1].sets[0].id,'link');
});

test('Linked videos autoplay muted and loop the selected video',()=>{for(const link of ['https://youtu.be/dQw4w9WgXcQ','https://vimeo.com/123456/abcdef1234']){const source=sources.parse(link),params=new URL(source.embed).searchParams;assert.equal(params.get('autoplay'),'1');assert.equal(params.get('loop'),'1');assert.equal(params.get(source.provider==='youtube'?'mute':'muted'),'1');if(source.provider==='youtube')assert.equal(params.get('playlist'),'dQw4w9WgXcQ');else assert.equal(params.get('h'),'abcdef1234');}});
