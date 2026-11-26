import { INKS, GRADIENTS, isHex, inkFill } from './inks.js'
import { lruGet, lruSet } from './lru.js'

// -------------------------------------------------------------------------
// Characters: DS Bot's own avatars, small 3D models (avatar/models.js) seen from a
// three-quarter view and flattened into crisp silhouettes in a 100-unit box, with
// optional accent decals. The eyes [cx, cy, width, height, tilt] are cut out of every
// layer, so they show whatever sits behind the avatar. dev/characters.mjs builds this
// table; the avatar engine turns the same models when a mark moves.
export const CHARACTERS = {
  whale: {label:'Whale',body:'M65.3 20.9l5.1 .1 4.8 .9 4.8 1.7 4.3 2.3 3.8 3.1 3 3.4 2.3 3.8 1.6 4.3 .9 4.3 0 4.8-.8 4.8-1.4 4.3-2.3 4.3-3.2 4.3-3.4 3.3-4.3 3.1-7.2 3.5-7.6 1.7-7.2 .1-9.6-1.6-3.3-1-2.9-1.7-8.8-8.9-6-4.7-3.3-.5-7.7 1.1-4.8-.1-4.7-1.2-1.9-1.2-1-1-.5-1.5 .4-1.4 1.1-1.3 1.9-1.3 4.7-1.5 7.7-.6 1.1-.5 .7-1 0-1.4-2.8-7.2-1.2-5.3-.1-4.3 .4-1.4 .9-1.2 1.9-.2 2 1 2.2 2.3 2.2 3.4 3.2 7.6 1.9 9.7 .5-.1 1.1-7.2 1.8-4.8 3.2-5.2 3.9-4.3 4.9-3.9 5.6-2.9 5.8-1.9z',paints:[['M93.3 55.8l1-.3 .1 1.2-2.4 5.3-3.4 4.8-3.8 3.8-4.8 3.4-5.7 2.8-4.8 1.5-4.8 .4 20.1-17.4 5.2-3.7z','#fff',1]],shade:'M88.6 29.5l2.4 2.9 1.9 2.8 2.4 6.3 .5 3.3 .1 5.3-1.5 6.6-1.9 4.3-2 3.3-4.8 5.4-5.7 4.3-7.2 3.3-6.2 1.5-6.7 .1-3.3-.2-9.6-1.8-3.3-1.5-2.4-1.9-8.6-8.9-5.3-3.9-3.3-.1-2.9 .2-3.3 .8-5.8 0-4.3-1-2.9-1.9 .6-.6 3.8-1.3 10.5-2.5 4.3 .9 1.4-.1 2.2-1.7 .5-1.4-.3-1.5-1.2-1.4-2.2-1.4-1.2-1.9-.6-12 .4-3.3 .5-.5 2.9 3.8 2.4 4.8 1.9 5.7 .7 5.8 .7 2.8 2.1 2.4 2.7 5.5 3.8 4.3 2.9 2.2 3.3 1 3.4-.4 6.2-3 7.1-4.5 7.3-5.6 6.6-5.9 5.9-6.5 3.7-5.3 1.7-4.2 .1-2.9z',light:'M55.6 22.8l1.9-.3 1.5 .3 .6 1 .1 .9-2 4.3-3.8 5.3-5.8 6.2-5.4 4.4-4.8 2.3-1.4 0-1.2-.5-.8-1.9 .5-3.3 2.5-4.8 3.3-4.3 2.4-2.4 5.3-3.9zM19.3 28.1l-1.4 2 .3-1.1zM21.7 49.1l.6 .5-.3 .5-.8 0zM35.8 52l1.2-.4 .9 .7 .7 1.6-.4 .9-1.2 .1-2.6-.5zM7.2 52.9l-2.9 2.9 1.2-1.6z',eyes:[[72.5,48.4,9.3,23,-15.8],[85.6,43.4,7,22.9,-21.2]]},
  star: {label:'Star',body:'M40.1 4.4l1.5-.4 1.9 .1 5.2 1.1 1.9 .9 13.2 14.9 17.1-.8 5.2 1.1 1.8 .9 1.7 1.6 .7 2.4-.4 1.9-9.7 23.6 5.6 23.7 .1 1.9-.6 1.4-2.1 1.8-2.3 .5-19.9-1.8-16.6 15.5-1.9 1-1.9 .3-7-1.5-2.6-2.1-.9-2.4-2.8-24.1-16-13.6-1.1-1.5-.5-1.9 .4-1.9 1.2-1.5 18.9-13.6 7.1-24.6 1-1.7z',eyes:[[53.9,53.4,7.2,18.8,-10],[65.1,49.2,7.2,18.8,-10]]},
  moon: {label:'Moon',body:'M44.4 4.3l8-.1 11.7 2.5 6.6 2.6 5.6 3.8 5.6 5.7 4.4 7.1 3.1 7.9 1.5 8.5 .1 9.4-1.6 9.4-3.2 8.9-4.9 8.4-5.9 6.8-7 5.4-7.5 3.6-8 1.7-7.5-.2-10.7-2.3-5.8-2.1-5-3-5.3-4.7-4.7-6.1-3.4-7.1-1.6-6.1 .3-4.2 .5-.9 .9-.4 7.5 1.7 6.1 5.3 1.5 0 2.8-1.1 2.5-1.8 2.3-2.3 2.2-3.1 2.7-6.3 .9-7-.9-6.6-1.3-3.1-1.6-2.5-1.8-1.9-1.3-.7-2.8 .9-6.1 3.1-1.9 .4-7-1.6-.7-1.2 .1-1.9 1.1-3.7 2.2-3.8 3.9-4.8 4.3-4.1 4.6-3.2 4.7-2.5 4.7-1.7z',eyes:[[61.3,54.8,6.9,18.1,-10],[72.4,50.7,6.9,18.1,-10]]},
  cloud: {label:'Cloud',body:'M43.6 11.6l6.7 .1 6.6 1.9 5.3 3.4 7.7 7.9 11.3 2.5 3.6 1.6 3.6 2.5 4.1 4.7 2.6 5.7 .9 6.6-1.1 6.5-1.5 3.6-1.9 2.9-4.9 5.3-17 11.4-6.8 3.5-8.9 2.8-9.5 1.3-13.1 2.5-6.5 .2-5.9-1.1-4.2-1.8-3.6-2.6-2.7-3-2.2-3.6-1.5-4.2-.7-4.1 .2-4.2 1-4.1 1.5-3.6 2.4-3.6 8.6-8.8 1.8-2.5 1.3-2.9 2.5-10.7 1.7-3.6 2.2-3.2 3.5-3.6 3.9-2.7 4.5-1.9z',eyes:[[55.7,62.2,8.5,20.1,-10.7],[74.4,55.5,6.8,20,-11.5]]},
  spark: {label:'Spark',body:'M32.9 4.3l2.9-.2 2.3 1 21.5 19.1 1.5-.7 2.4-2.3 1.9-1.1 2.3-.1 2.1 1.2 1.2 1.7 3.1 7.6 8.4 13.9 2.6 6.5 1.2 6.2-.2 7-1.6 7-3.1 6.4-4.4 5.8-5.3 4.8-6.3 3.9-6.4 2.4-7 1.4-7 .1-6.9-1.2-6.4-2.4-5.8-3.7-5-4.8-3.7-5.5-2.4-6.1-.9-4-.3-4.1 .3-4.6 .8-4.1 2.5-7 6-11 1.8-4.1 .9-3.4 3.4-21.5 1.2-2.5z',eyes:[[60.7,67.1,8.3,19.7,-11.2],[76.9,61,6.2,19.6,-12.1]]},
  bear: {label:'Bear',body:'M63.8 4.5l5.2-.4 4.9 1.4 3.9 2.8 2.9 4.4 1 3.2 .1 3.9-.5 2.7-1.7 4.4-.2 2.1 .9 2.2 3.8 4.4 2.6 3.8 1.9 3.9 1.3 3.8 1 4.4 .3 4.9-.3 4.9-1.1 4.9-2.8 7.1-4.3 6.7-5.7 5.9-6.9 4.7-7.6 3.3-7.7 1.8-8.2 .2-7.6-1.3-7.1-2.7-6.6-4.3-5.4-5.5-3.6-6.1-2.5-7.1-.8-7.1 .6-7.1 2.1-7.1-3.5-3.3-2.3-3.8-1.1-4.3 .5-5 1.3-3.2 2.5-3.3 2.9-2.2 3.8-1.5 4.4-.4 3.9 .8 3.8 2 3.2 3.3 7.1-2.9 8.2-2 1.1-.7 .9-1.3 1.3-6.1 2.2-4 3.3-3.1z',eyes:[[62.1,63.9,9,21.4,-11.5],[80.4,57,6.7,21.3,-13.3]]},
  puppy: {label:'Puppy',body:'M48.2 13.7l4.1 0 4.3 .5 7.7 2.3 3.8-2.2 3.9-.5 3.2 .8 2.8 1.7 2.2 2.7 15 26.4 .8 4.4-.3 2.2-.9 2.2-2.6 3.1-3.8 1.9-3.8 .2-3.9-1.3-3.8 6.5-4.9 5.5-5.5 4.2-6.6 3.2-4.4 1.3-4.3 .8-5 .2-4.3-.4-4.4-1-4.4-1.6-3.8-2-3.9-2.8-.4 .8-1.4 7.1-1.2 2.2-1.9 2-2.7 1.6-2.8 .6-2.7-.1-2.7-.9-2.3-1.5-1.8-2.2-1.2-2.8-.3-2.7 5.5-34.5 1.1-3.2 1.3-1.7 1.8-1.7 4.1-1.6 5.4-7.7 3.4-3.3 3.8-2.8 4.3-2.4 4.4-1.8 4.4-1.1z',eyes:[[58,51.9,8.8,20.6,-11.1],[74.8,45.6,6.3,20.5,-12.6]]},
  kitty: {body:'M62.4 4.2l1.6-.1 1.5 1.2 7.4 21.3 3.7 6.4 6.2 7.4 3.1 5.9 1.5 4.8 .7 5.3-.2 5.4-1.1 5.3-3 7.4-4.4 6.4-5.3 5.4-6.9 4.6-7.5 3.1-8 1.7-8 .2-7.4-1.4-4.3-1.5-3.7-1.8-3.8-2.5-3.1-2.7-2.7-3-2.5-3.7-1.9-3.7-1.4-4.3-.9-5.3 .1-5.8 1.4-7 1.6-4.2 2-3.8 .8-3.2 .2-20.2 1.1-1.4 1.1-.3 1.1 .3 12.2 9.7 5.9-2.5 8-2.1 3.2-1.8 2.3-2.4 8.3-16z',eyes:[[59.6,65.1,9.4,22.6,-11.9],[77.5,58.4,7,22.5,-14]]},
  bunny: {body:'M49.3 4.4l1.5-.4 2 1.2 1.6 2.7 1.2 3.4 1.6 8.9 .2 6-.2 6.4 .6 3 2.4 2.5 5.4 3 3.4 2.4 5.1 5.5 2.4 3.9 1.7 4 1.1 4.4 .4 4.5-.5 5.9-1.6 5.5-2.8 5.4-3.6 4.5-4.6 3.8-4.9 2.7-5.5 1.7-5.9 .7-6-.5-5.4-1.7-4.9-2.5-4.7-3.7-3.8-4.5-2.7-4.9-1.8-5.5-.7-5.9 .6-6.5 1.9-5.9 3.1-5.4 4.6-5.5-.4-2-3.4-8.4-1.8-6.9-.6-6.9 .3-3 .6-2 1.3-1.4 2-.1 2.5 1.5 2.1 2.5 4 6.9 2.1 5.5 1.7 5.9 1.5 2.1 1.8-1.6 .7-2-.4-12.4 1-8.9 1.6-4.9z',eyes:[[59.2,69.2,8.2,19.3,-12],[72.9,64,5.6,19.1,-15.4]]},
  octopus: {label:'Octopus',body:'M41.9 4.2l4.4-.2 4.5 .3 8 2 4 1.7 3.5 2.1 3.4 2.7 2.8 3 2.4 3.3 1.9 3.4 1.5 4 .8 4 .3 4-.3 4.5-.9 4-1.4 4 1.4 1.5 9.8 5.7 1.7 1.5 1.2 1.6 .9 2.3 .4 2.3-.2 2.3-.8 2.3-1.6 2.2-2.2 1.8-2.9 1.1-2.3 .1-2.2-.3-6.6-3.2 2.7 6.2 .2 4-.6 2.3-1.4 2.3-1.8 1.7-1.7 1-4 .8-4-.9-2.8-2-2.3-3.6-.3 .7 .2 5.7-1.6 3.8-1.7 1.8-2 1.3-2.6 .8-2.3 .1-3.4-.9-3-2.3-1.7-2.8-1.3-5.2-.3-.6-.6 .1-3.1 7.9-2 2.9-1.7 1.3-2.3 1-2.3 .4-2.3-.2-2.4-.8-2.4-1.7-1.7-2.3-.9-2.3-.3-2.3 .3-2.2 4.8-13.8 .4-3.4-1.2-3.4-6.9-7.9-3.4-6.4-1.2-4-.6-4 0-4 .5-4.5 1.6-5.2 2.5-5.1 3.2-4.6 4.3-4.3 5-3.7 5.3-2.7 5.7-1.9z',eyes:[[53.6,44.1,8.6,19.9,-10],[71.1,37.5,6.1,19.9,-10]]},
  sprout: {label:'Sprout',body:'M63.2 4.1l3 .2 1.2 .8 .7 1.1 .3 1.6-.2 2.1-1.6 4.2-3.6 5-4.7 4.4-4.8 3-5.4 1.7-.3 1.1 .4 2.6 .6 .5 4.7-.1 4.3 .5 6.3 1.7 6.3 3.2 5.7 4.9 4.4 6.1 2.6 6.8 .8 7.4-1.1 7.4-2.4 6.3-3.7 5.7-4.8 5-5.7 4-6.3 2.8-6.9 1.6-6.8 .2-6.8-1-4.8-1.6-4.7-2.5-4.1-3.2-3.5-3.7-2.7-4.2-2-4.7-1.1-4.7-.4-5.3 .6-4.7 1.2-4.8 2.1-4.7 2.8-4.2 3.4-3.9 4.2-3.5 4.8-2.9 5.4-2.3 0-1.6-.2-.4-3.1 1.6-3.7 .7-3.7-.2-3.7-.9-3.1-1.5-2.6-2.1-1.4-2.4 0-2.1 .9-1.6 1.5-1.2 2.6-1 2.7-.4 5.7 .5 6.3 2.6 .3-3.1 1.3-1.9 2.1-.7 2.6 .9 4-5.7 4.4-4.5 5.1-3.3z',eyes:[[59.4,69.3,8.7,20.6,-11.1],[75.5,63.2,6.3,20.6,-12.6]]},
  bloom: {label:'Blossom',body:'M45 4.1l3-.1 2.9 .4 2.9 .9 2.8 1.5 2.4 1.9 2.1 2.3 3 5.3 4-1.3 4.6-.4 4.6 .9 4 2 3.7 3.3 2.7 4 1.5 4.6 .4 4.6-.7 4.6-1.9 4.6-2.2 3.3-4.1 3.6-.5 1.1 3.1 4.1 1.6 2.8 1.2 3.5 .6 3.4-.1 4.1-.8 3.4-1.4 3.5-1.9 2.9-2.3 2.5-2.8 2-3 1.5-2.8 .9-3.5 .3-2.8-.2-6.4-2-2.8 4.9-4.1 3.9-5.1 2.5-5.8 .8-4-.6-4-1.7-3.5-2.6-2.5-3.1-2.3-4.6-.9-4.6 .3-5.1 1.4-4.6-6.3-2.6-2.7-2-2.2-2.3-1.8-2.9-1.2-2.9-.8-3.4-.2-3.5 .4-3.4 1.1-3.5 1.8-3.4 2.2-2.9 2.8-2.4 2.9-1.7 3.4-1.2 4.1-.5 .3-.5-.9-5.2 .3-4.6 1.3-4.6 2.4-4.1 2.6-2.8 3.1-2.3 3.5-1.5z',eyes:[[54.2,55.2,8,18.1,-10],[69.4,49.5,5.1,18.1,-10]]},
  acorn: {body:'M47.6 4l2.1 .6 1.3 1.5 .4 1.5-.4 5.2 .3 .3 8.8-.1 7.7 1 7.3 2.1 5.7 2.9 3.6 2.9 2.6 3 1.8 3.4 .9 3.7 0 4.1-1 3.6-1.7 2.2-3.9 3 2.9 8.3 .9 8.3-.9 8.3-2.7 7.7-4.2 6.8-2.9 3.1-3.2 2.6-6.7 3.8-3.7 1.2-4.1 .8-7.2 0-7.3-1.7-7-3.6-5.9-5.1-4.8-6.3-3.3-7.3-1.8-7.7-.1-8.3-4.5-1.5-2.6-1.7-2.6-4.1-1.1-4.1 0-4.2 1.2-4.1 2.2-4.1 2.8-3.7 5.2-4.6 6.3-3.8 7.2-3.2 8.3-2.3 .9-8.3 1.2-1.4z',eyes:[[63.6,63.3,9.6,22.7,-11.9],[79.5,57.3,6.5,22.5,-15.5]]},
  squircle: {label:'Squircle',body:'M54.5 4.2l3.9-.2 3.7 .3 11.6 2.7 3.1 1.6 2.8 1.9 2.6 2.7 2.2 3.1 2.4 4.8 1.9 5.8 3.7 19.4 .8 11.1-.4 4.7-1 4.7-1.3 3.5-1.8 3.4-4.8 5.8-6.4 4.7-8 4-14.2 5.3-9.5 2.2-7.4 .1-10.5-2.2-5.3-2.5-4.3-3.7-3.3-4.8-2.7-6.3-2.4-9.5-2.8-17.9-.2-7.8 1.3-7.9 2.2-5.3 2.8-4.2 4.1-4.2 4.3-3.1 6.3-3.4 11.6-4.6 7.9-2.7z',eyes:[[52.6,52.4,8.4,22.1,-10],[67.3,46.9,8.4,22.1,-10]]},
  gumdrop: {body:'M38.7 4.5l4.4-.5 4.6 .8 4.1 1.9 3.7 3.2 23.2 36.6 2.3 5 1.4 5.1 .7 6.4-.7 6.4-1.8 6.1-3.1 5.7-4.1 5.1-5.2 4.2-5.8 3.1-6 1.8-6.4 .6-6.4-.6-6-1.8-5.9-3.1-5.1-4.2-4.1-5.1-3-5.4-1.9-6.4-.7-6 .5-5.9 9-41.6 2-4.1 2.6-3.2 3.4-2.5z',eyes:[[52.1,40.3,9.7,22.9,-15.2],[64.8,35.6,6.3,23,-27]]},
  peanut: {body:'M43.5 4l6.6 .7 5.8 2.2 5.4 3.8 4.1 4.7 2 3.8 1.4 4.3 1.3 11.9 1 4.3 1.6 3.8 5.8 10.5 1.4 3.8 .8 4.3 .1 6.2-1 5.7-2.1 5.5-3.2 4.9-4.1 4.3-4.8 3.4-5.6 2.4-5.7 1.3-6.1 .1-5.8-1.1-5.7-2.2-4.7-3.1-4.3-4.1-3.3-4.8-2.5-5.7-1.2-5.7-.1-6.7 1.7-9 .4-4.3-.5-4.7-2.5-9.6-.6-3.8 .2-5.2 1.2-5.2 1.5-3.4 2.2-3.3 2.5-2.9 2.8-2.3 3.4-2.1 3.4-1.4 3.8-.9z',eyes:[[50.9,31.5,8.7,20.5,-11.9],[64.2,26.5,5.7,20.3,-16.3]]},
  saucer: {body:'M45 22.7l6.7 .1 6.7 1.9 4.3 2.5 3.5 3.1 2.8 3.5 2.5 4.5 6.8 .9 5.6 1.2 4.5 1.6 3.5 2.1 2.8 2.8 1.3 3.5-.5 3.5-2 3.5-2.6 2.8-3.5 2.8-4.5 2.8-5.1 2.6-12 4.4-13.6 3.1-13.6 1.5-12.6-.3-5.5-.7-5-1.2-4.1-1.6-3.5-2-2.8-3.1-1.1-3 .5-3.5 2-3.6 2.7-3 3.7-2.9 10.3-5.6 .7-5.1 1.5-4.5 2.6-4.5 3.1-3.5 3-2.4 3.5-2 3.5-1.4z',eyes:[[53.6,45,7.8,18.4,-14.5],[66.2,40.3,5,18.3,-25.1]]},
  beacon: {body:'M40 4.1l2.7 0 2.5 .9 2 1.7 1.1 2.1 .5 2-.2 2.1-2.1 4.1-.4 1.6 1.5 7.7 9-3.1 4.1-.2 18.5 4 3.1 1.6 2.4 2.3 1.3 2.1 .9 2.6 5.8 33.4-.4 3.1-1.3 3.1-2 2.5-2.6 1.9-41.7 15.7-4.1 .7-19.6-4-3.5-1.9-2.5-2.5-1.2-2.1-.8-2.6-5.7-32.9 .4-3.1 1-2.7 1.7-2.5 2.4-1.9 28.4-10.9-1.5-9.3-.7-1-3.5-3.3-.9-1.9-.4-2 .5-2.6 1.1-2.1 1.7-1.5z',eyes:[[55.5,65.3,8.4,22.1,-10],[74.2,58.3,8.4,22.1,-10]]},
  pebbles: {body:'M47.3 4.5l2.7-.4 2.7 .1 13.7 3 4.3 2.1 3.3 3.4 1.3 2.2 1 2.8 2 12-.5 4.3-3.1 7.7 .2 .5 8.4 1.9 2.7 1 3.3 2.1 2.7 2.8 2.4 4.3 1.4 6.5 .1 4.4-.8 3.8-1.3 2.7-2 2.8-2.4 2.2-2.7 1.6-45.5 17-3.3 .6-3.2-.2-19.2-4.2-4.9-2.8-3.4-3.8-1.9-4.4-1.3-7.7 .2-3.2 .8-2.8 1.3-2.7 2-2.7 3.2-2.8 7.9-3.8 2.5-2.2-.4-1.6-5.4-6.1-1.8-3.8-2.3-12.5 .2-3.3 .7-2.7 2.6-4.4 2.2-2 2.2-1.4z',eyes:[[51.2,34.1,6.9,18.1,-10],[66.4,28.4,6.9,18.1,-10]]},
  plus: {body:'M44.6 4.3l3.3-.1 11.9 2.5 2.5 1.3 1.3 1.4 .7 1.6 2.1 11.4 4.1-1.2 2.1 0 12.3 2.6 2.8 1.6 1.2 1.5 .7 1.5 3.8 21.6-.5 3.1-1 1.5-1.3 1.3-17 6.6 3.4 20.4-.4 2.5-1.2 2.1-2.3 1.6-19 6.9-2-.2-11.9-2.5-2.5-1.3-1.3-1.4-.7-1.6-2.1-11.4-4.1 1.2-2.1 0-12.3-2.6-2.8-1.6-1.2-1.5-.7-1.5-3.8-21.6 .5-3.1 1-1.5 1.3-1.3 17-6.6-3.4-20.4 .2-2 1.1-2.2 2.6-2z',eyes:[[54.5,53.1,6.1,15.9,-10],[64.5,49.4,6.1,15.9,-10]]},
  magnet: {body:'M71.9 4.2l1.2-.2 12.1 2.6 .5 .3 .6 1 6.2 35.6 .6 5.8-.1 5.7-.7 5.8-1.5 5.7-2.2 5.8-4.2 7.3-5.5 6.5-6.5 5-7.1 3.4-6.3 1.3-6.3 0-15.2-3.1-5.2-1.8-5.2-3-4.6-4.1-4-5.2-2.9-5.8-2.4-7.8-6.4-36.2 25-9.5 13.1 2.9 .5 .9 6.3 35.3 1.8-3.9 .5-4.7-6.3-36.1 .4-.6z',eyes:[[59.6,82.1,6.1,15.9,-10],[72,77.5,6.1,15.9,-10]]},
  ring: {body:'M48.1 4.3l8-.1 7.8 1.8 7.3 3.5 6.7 5.4 5.2 6.7 4.1 8.3 2.3 8.9 .7 9-1 9.5-2.5 8.9-4.1 8.3-5.3 7.3-6.6 6.1-7.3 4.5-7.8 2.7-8.4 .9-7.2-.8-7.3-2.5-6.7-4.1-5.6-5.3-4.5-6.5-3.5-7.8-2-8.4-.6-8.4 .9-8.9 2.2-8.4 3.5-7.8 4.9-7.2 5.8-6.1 6.3-4.5 7.1-3.3zM50.5 33.8l2.3-.3 1.7 .4 1.6 1.1 2 2.2 1.3 2.8 .8 2.7 .4 3.4-.1 3.3-1.4 6.2-3 5.6-2.2 2.4-2.2 1.6-2.3 1-2.2 .3-1.7-.4-1.6-1.1-2.8-3.7-1.5-5.2-.1-5.5 1.2-5.6 2.4-5 3.6-4z',eyes:[[56.2,84.6,5.3,13.3,-6.8],[71.7,78.8,5.1,13.4,-6.5]]},
  gem: {body:'M57 9.3l2.9-.4 14.9 3.5 19.6 14.1 1 1.4 .6 1.6-.5 2.6-27.1 56.5-1.6 1.8-2.1 .7-15.9-3.4-42.9-30.7-1.3-1.6-.6-1.6 .5-2.6 12-25.2 1.1-1.5 1.5-1z',eyes:[[51.4,42.9,6.7,17.7,-10],[66.1,37.4,6.7,17.7,-10]]},
}
// Legacy shapes stay renderable for Bots that already saved them, while staying out of the picker.
const LEGACY_SHAPES = new Set(['magnet', 'ring', 'gem'])
// Replaced shape keys map cleanly onto active characters so existing Bots never break.
export const SHAPE_ALIASES = Object.freeze({
  zed: 'bear',
  wave: 'octopus',
  hex: 'bloom',
  cushion: 'squircle',
  dolphin: 'whale',
  turtle: 'acorn',
  crab: 'octopus',
  puffer: 'cloud',
  jelly: 'octopus',
  starfish: 'star',
  seahorse: 'whale',
})
// The picker shows 20 active characters, five to a row (4x5). A Bot with no choice gets
// one of the friendliest non-whale shapes; the whale stays the Main Bot's.
// Slots keep the surviving shapes at their original indices so existing Bots stay stable.
export const PICKER_SHAPES = Object.keys(CHARACTERS).filter(id => !LEGACY_SHAPES.has(id))
export const PICKER_COLUMNS = 5
export const DEFAULT_SHAPES = ['star', 'moon', 'cloud', 'octopus', 'spark', 'bear', 'puppy', 'sprout', 'bloom', 'squircle', 'gumdrop', 'peanut', 'bunny', 'kitty', 'acorn']
export const FALLBACK_SHAPE = 'gumdrop'
// The team's first Main Bot, and the plugin's own mark in the sidebar.
export const MAIN_LOOK = Object.freeze({ shape: 'whale', color: 'deepseek' })
// Character colors in picker order. Black, the gradients, and the dull gray and brown
// are never defaults; the user must pick them.
export const CHARACTER_COLORS = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray', 'aurora']
export const DEFAULT_COLORS = CHARACTER_COLORS.filter(color => !['black', 'gray', 'brown'].includes(color) && !GRADIENTS[color])
export const isColor = color => isHex(color) || Object.hasOwn(INKS, color)

// Registered shapes join the characters: `body(paint)` returns SVG markup in a
// `size` box and `eyes` lists the two capsules.
export const SHAPES = {}
for (const [id, character] of Object.entries(CHARACTERS)) {
  const layers = (character.paints ?? [])
    .map(([d, fill, opacity]) => `<path d="${d}" fill="${fill}" fill-opacity="${opacity}"/>`)
    .join('')
  SHAPES[id] = { label: character.label ?? id[0].toUpperCase() + id.slice(1), size: 100, path: character.body, layers, eyes: character.eyes }
}

// The default look comes from the Bot id (FNV-1a, then mulberry32 for the
// color and murmur3's fmix32 for the shape), so it is the same on every device.
export function fnv1a(text) {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619)
  return value >>> 0
}
export function defaultColor(id) {
  const t = (fnv1a(id) + 1831565813) | 0
  let n = Math.imul(t ^ (t >>> 15), 1 | t)
  n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n
  return DEFAULT_COLORS[Math.floor((((n ^ (n >>> 14)) >>> 0) / 4294967296) * DEFAULT_COLORS.length)]
}
export function defaultShape(id) {
  let value = fnv1a(id) | 0
  value = Math.imul(value ^ (value >>> 16), 73244475)
  value = Math.imul(value ^ (value >>> 13), 3266489909)
  return DEFAULT_SHAPES[((value ^ (value >>> 16)) >>> 0) % DEFAULT_SHAPES.length]
}

// A stored shape or color wins; then the id. With no Bot it is a black gumdrop.
export const colorOf = bot => (isColor(bot?.color) ? bot.color : bot?.id ? defaultColor(String(bot.id)) : 'black')
// Exact registered ids (built-in or custom) take precedence over legacy aliases.
export const resolveShape = id => (typeof id === 'string' && !Object.hasOwn(SHAPES, id) && Object.hasOwn(SHAPE_ALIASES, id) ? SHAPE_ALIASES[id] : id)
export function lookOf(bot) {
  const avatar = bot?.avatar ?? {}
  const stored = resolveShape(avatar.shape)
  return {
    shape: hasShape(stored) ? stored : bot?.id ? defaultShape(String(bot.id)) : FALLBACK_SHAPE,
    image: avatar.image,
    color: colorOf(bot),
  }
}

export const hasShape = id => typeof id === 'string' && Object.hasOwn(SHAPES, resolveShape(id))
export const shapeId = (id) => {
  const resolved = resolveShape(id)
  return typeof resolved === 'string' && Object.hasOwn(SHAPES, resolved) ? resolved : FALLBACK_SHAPE
}
export const shapeOf = id => SHAPES[shapeId(id)]
// `flat` draws the silhouette alone, for masks and selection rings.
export function bodyOf(def, paint, flat = false) {
  if (def.path) return `<g fill-rule="evenodd"><path d="${def.path}" fill="${paint}"/>${flat ? '' : def.layers}</g>`
  try { return def.body(paint) } catch { return '' }
}
const eyeMarkup = ([cx, cy, w, h, tilt]) => `<g transform="translate(${cx} ${cy}) rotate(${tilt})"><rect class="bt-eye" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${w / 2}"/></g>`
// A mask covering three boxes, so a bob or squash never clips the body at the edge.
export const maskBox = size => `maskUnits="userSpaceOnUse" x="${-size}" y="${-size}" width="${size * 3}" height="${size * 3}"`
export const holes = (def, eyes) => `<rect x="${-def.size}" y="${-def.size}" width="${def.size * 3}" height="${def.size * 3}" fill="#fff"/>${eyes}`

// MASK_ID stands for each mark's own mask id: a duplicate id resolves to its first
// copy, which stops painting once that copy unmounts or sits in a hidden subtree.
export const MASK_ID = '%MASK%'
let markSerial = 0
export const nextMarkSerial = () => (markSerial += 1)
const MAX_MARKUP_CACHE = 256
const MAX_MASK_CACHE = 128

export const markupCache = new Map()
export function characterMarkup(shape, color) {
  const resolved = shapeId(shape)
  const key = `${resolved}|${color}`
  let markup = lruGet(markupCache, key)
  if (markup === undefined) {
    const def = SHAPES[resolved]
    // The flat art is the rest pose; a mark that moves is drawn by the avatar engine
    // (avatar/), so the eyes here never change.
    const eyes = `<g class="bt-eyes" fill="#000">${def.eyes.map(eyeMarkup).join('')}</g>`
    const stops = GRADIENTS[color]
    const gradient = stops ? `<linearGradient id="${MASK_ID}g" gradientUnits="userSpaceOnUse" x1="18" y1="10" x2="78" y2="92">${stops.map(([offset, value]) => `<stop offset="${offset}" stop-color="${value}"/>`).join('')}</linearGradient>` : ''
    const body = `<g mask="url(#${MASK_ID})">${bodyOf(def, stops ? `url(#${MASK_ID}g)` : inkFill(color))}</g>`
    markup = `<defs>${gradient}<mask id="${MASK_ID}" ${maskBox(def.size)}>${holes(def, eyes)}</mask></defs><g class="bt-b">${def.wrap ? `<g transform="${def.wrap}">${body}</g>` : body}</g>`
    lruSet(markupCache, key, markup, MAX_MARKUP_CACHE)
  }
  return markup
}
const svgUrl = (inner, size) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${inner}</svg>`)}")`
export const maskCache = new Map()
export function maskOf(shape) {
  const resolved = shapeId(shape)
  let mask = lruGet(maskCache, resolved)
  if (mask === undefined) {
    const def = SHAPES[resolved]
    const body = `<g mask="url(#e)">${bodyOf(def, '#000', true)}</g>`
    mask = svgUrl(`<mask id="e" ${maskBox(def.size)}>${holes(def, def.eyes.map(eyeMarkup).join('').replaceAll('class="bt-eye"', 'fill="#000"'))}</mask>${def.wrap ? `<g transform="${def.wrap}">${body}</g>` : body}`, def.size)
    lruSet(maskCache, resolved, mask, MAX_MASK_CACHE)
  }
  return mask
}
export const DEFAULT_MASK = maskOf(FALLBACK_SHAPE)
