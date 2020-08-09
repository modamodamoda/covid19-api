# covid19-api
COVID 19 cases API updating from john hopkins and worldometers for live totals

## How to use

First, git clone this. Then, git clone https://github.com/CSSEGISandData/COVID-19/ into the directory. Then, run index.js.

## API endpoints

#### Live endpoints

These endpoints show data from worldometers, and is a little inconsistent with the Hopkins data.

- /live - get a live summary (total cases etc)
- /live/countries - get a live summary with countries

#### Archive endpoints

These endpoitns access the JHU data, which is updated infrequently and is inconsistent with the worldometers data.

- /summary - get a summary (total cases etc) of the last updated day
- /summary/countries - get a summary with a country list of the last updated day
- /summary/YYYY-MM-DD(/YYYY-MM-DD) - get a summary over a time series
- /country/COUNTRYNAME - get stats for a country
- /country/COUNTRYNAME/state/STATENAME - get stats for a locality
- /country/COUNTRYNAME/YYYY-MM-DD(/YYYY-MM-DD) - get country stats with a time
- /country/COUNTRYNAME/state/STATENAME/YYYY-MM-DD(/YYYY-MM-DD) - get locality stats with a time

## Things to do
Endpoint error handling for time series (i.e. something doesn't exist)
Proper testing
