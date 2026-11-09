// TODO: After implementing this file delete/rename anything that uses station.js or ALLOWED_STATIONS

import { writeFileSync } from 'node:fs';

const url = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels';
const { stations } = await (await fetch(url)).json();

const slim = stations.map(s => ({ id: s.id, name: s.name, state: s.state, lat: s.lat, lng: s.lng }));
writeFileSync('data/stations.json', JSON.stringify(slim, null, 2));
