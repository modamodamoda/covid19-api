const parse = require('csv-parse');
const fs = require('fs');
const express = require('express');
const { exec } = require('child_process');
const cheerio = require('cheerio');
const fetch = require('node-fetch');

const app = express();
const dateRegex = /^[0-9]{4}-(0[1-9]|[12][0-9]|3[01])-(0[1-9]|1[012])$/;

const localeCorrection = { // apologies to any countries that aren't named how you like
    'USA': 'US',
    'UK': 'United Kingdom',
    'UAE': 'United Arab Emirates',
    'S. Korea': 'Korea, South',
    'Ivory Coast': 'Cote d\'Ivoire',
    'Congo (Kinshasa)': 'DRC',
    'Congo (Brazzaville)': 'Republic of Congo',
    'Congo': 'Republic of Congo',
    'West Bank and Gaza': 'Palestine',
    'Taiwan*': 'Taiwan', // Why a star, WHO? ;)
};

// Functions

function localeFix(s) {
    return localeCorrection[s] || s;
}

function validateDate(date) {
    if(!date.match(dateRegex)) return false;
    let d = new Date(date);
    if(d.getFullYear() < 2020 || d > new Date()) return false; // there is nothing before 2020
    return true;
}


function fmtDate(date = new Date()) {
    return (date.getMonth() + 1).toString().padStart(2, '0') + '-' + date.getDate().toString().padStart(2, '0') + '-' + date.getFullYear();
}

function execSync(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) reject(error);
            resolve(stdout? stdout : stderr);
        });
    });
}

async function readFile(path) {
    return new Promise((resolve, reject) => {
      fs.readFile(path, 'utf8', function (err, data) {
        if (err) {
          reject(err);
        }
        resolve(data.toString());
      });
    });
}

// Classes
 
class Record {
    constructor(data) {
        this.children = {};
        this.data = data || {};
    }
    child(key, data = null) {
        if(data != null) this.children[key] = new Record(data);
        else if(!this.children[key]) this.children[key] = new Record();
        return this.children[key];
    }
    format(withChildren = 0, date = null) { // withChildren is how many levels of children you want
        let data = {
            Confirmed: this.data.TotalConfirmed || this.data.Confirmed,
            Deaths: this.data.TotalDeaths || this.data.Deaths,
            Active: this.data.TotalActive || this.data.Active,
            Recovered: this.data.TotalRecovered || this.data.Recovered
        };
        if(withChildren > 0) {
            let children = {};
            for(let i in this.children) {
                children[i] = this.children[i].format(withChildren - 1);
            }
            data.children = children;
        }
        return data;
    }
    recalculateTotals() {
        if(Object.keys(this.children).length > 0) {
            let Confirmed = 0;
            let Deaths = 0;
            let Recovered = 0;
            let Active = 0;
            for(let i in this.children) {
                // recalculate totals
                this.children[i].recalculateTotals();
                Confirmed += this.children[i].data.TotalConfirmed || this.children[i].data.Confirmed;
                Deaths += this.children[i].data.TotalDeaths || this.children[i].data.Deaths;
                Active += this.children[i].data.TotalActive || this.children[i].data.Active;
                Recovered += this.children[i].data.TotalRecovered || this.children[i].data.Recovered;
            }
            if(this.data.Confirmed !== undefined) { // Hopkins don't have the best data
                Confirmed += this.data.Confirmed;
                Deaths += this.data.Deaths;
                Active += this.data.Active;
                Recovered += this.data.Recovered;
            }
            this.data.TotalConfirmed = Confirmed;
            this.data.TotalDeaths = Deaths;
            this.data.TotalActive = Active;
            this.data.TotalRecovered = Recovered;
        }
    }
}

class DB {
    constructor() {
        this.CountryInfo = {}; // Country code -> info (population, etc) , children -> localised info
        this.Data = {}; // Totals -> Country code -> data (day, cases) , children -> localised data
        this.lastDate = null; // get the last date available
    }
    lookupCountry(country, date) {
        if(!date) date = this.lastDate;
        if(this.Data[fmtDate(date)] === undefined) return null; // out of bounds
        return this.Data[fmtDate(date)].children[country];
    }
    lookupLocality(country, locality, date) {
        if(!date) date = this.lastDate;
        if(this.Data[fmtDate(date)] === undefined) return null; // out of bounds
        return this.Data[fmtDate(date)].children[country].children[locality];
    }
    lookupTotal(date) {
        if(!date) date = this.lastDate;
        if(this.Data[fmtDate(date)] === undefined) return null; // out of bounds
        return this.Data[fmtDate(date)];
    }
    tsCountry(country, start, end = null) {
        let dataset = [];
        if(!start) return false;
        if(end == null) end = this.lastDate;
        while(start <= end) {
            const data = this.lookupCountry(country, start);
            if(data !== null) dataset.push({date: fmtDate(start), rec: data});
            start.setDate(start.getDate() + 1);
        }
        return dataset;
    }
    tsLocality(country, locality, start, end = null) {
        let dataset = [];
        if(!start) return false;
        if(!end) end = this.lastDate;
        while(start <= end) {
            const data = this.lookupLocality(country, locality);
            if(data !== null) dataset.push({date: fmtDate(start), rec: data});
            start.setDate(start.getDate() + 1);
        }
        return dataset;
    }
    tsTotal(start, end = null) {
        let dataset = [];
        if(!start) return false;
        if(!end) end = this.lastDate;
        while(start <= end) {
            const data = this.lookupTotal();
            if(data !== null) dataset.push({date: fmtDate(start), rec: data});
            start.setDate(start.getDate() + 1);
        }
        return dataset;
    }
    processRecord(date, record) {
        if(!this.Data[date]) this.Data[date] = new Record();
        let focus = this.Data[date];
        if(record.Country == 'Mainland China') record.Country = 'China'; // China almighty
        focus = focus.child(record.Country);
        if(record.State) {
            // this is a 1 layered entry
            focus = focus.child(record.State);
        }
        if(record.Admin) {
            // this is a 2 layered entry
            focus = focus.child(record.Admin);
        }
        // set the data
        focus.data = record;
        // if this is the highest date available, update as such
        if(!this.lastDate || new Date(date) > this.lastDate) this.lastDate = new Date(date);
    }
}

// Processing

var database = new DB();

function processFile(date) {
    return new Promise(async (resolve, reject) => {
        const content = await readFile('./COVID-19/csse_covid_19_data/csse_covid_19_daily_reports/' + date + '.csv');
        // Parse the CSV content
        parse(content, { delimiter: ',', columns: true }, (err, output) => {
            if(err) {
                reject(err);
                return;
            }
            for(let i in output) {
                let record;
                output[i].Country_Region = localeFix(output[i].Country_Region);
                if(output[i].FIPS !== undefined) {
                    // new format
                    record = {
                        Country: output[i].Country_Region,
                        Confirmed: parseInt(output[i].Confirmed) || 0,
                        Deaths: parseInt(output[i].Deaths) || 0,
                        Recovered: parseInt(output[i].Recovered) || 0,
                        Active: parseInt(output[i].Active) || 0,
                        Incidence_Rate: output[i].Incidence_Rate,
                        Case_Fatality: output[i]['Case-Fatality_Ratio']
                    };
                    if(output[i].Province_State != '') { 
                        if(output[i].Province_State == 'Hong Kong' || output[i].Province_State == 'Macau') record.Country = output[i].Province_State; 
                        else record.State = output[i].Province_State;
                    }
                    if(output[i].Admin2 != '') record.Admin = output[i].Admin2;
                } else {
                    // old format
                    record = {
                        Country: output[i]['Country/Region'],
                        State: output[i]['Province/State'],
                        Confirmed: parseInt(output[i].Confirmed) || 0,
                        Deaths: parseInt(output[i].Deaths) || 0,
                        Recovered: parseInt(output[i].Recovered) || 0
                    }
                }
                database.processRecord(date, record);
            }
            database.Data[date].recalculateTotals();
            resolve();
        });
    });
}
  
async function refreshDB(manual = false) {
    // Read the content from the GitHub
    let dirList;
    try {
        dirList = fs.readdirSync('./COVID-19/csse_covid_19_data/csse_covid_19_daily_reports/').reverse();
    } catch(e) {
        // git clone
        throw('Please run git clone https://github.com/CSSEGISandData/COVID-19/');
    }
    let res = await execSync('cd COVID-19 && git pull');
    if(manual || res.indexOf('Already up to date.') === -1)  {
        console.log('Loading new data...');
        for(let i of dirList) {
            if(i.match(/^[0-9]{2}-[0-9]{2}-[0-9]{4}\.csv$/)) {
                const spl = i.split('.');
                await processFile(spl[0]);
            }
        }
    } else console.log('Already up to date, no need to refresh');
    // Read the content from worldometer for updated 'live' data, inspired by https://github.com/javieraviles/covidAPI
    console.log('Updating real time stuff.');
    const WMData = await fetch('https://www.worldometers.info/coronavirus/').then(res => res.text());
    const WMHTML = cheerio.load(WMData);
    let updatedRecord = {};
    WMHTML('.maincounter-number').filter((i, el) => {
        let count = el.children[0].next.children[0].data || "0";
        count = parseInt(count.replace(/,/g, "") || "0", 10);
        if (i == 0) {
            updatedRecord.TotalConfirmed = count;
        } else if (i == 1) {
            updatedRecord.TotalDeaths = count;
        } else {
            updatedRecord.TotalRecovered = count;
        }
    });
    updatedRecord.TotalActive = updatedRecord.TotalConfirmed - updatedRecord.TotalDeaths - updatedRecord.TotalRecovered;
    Object.assign(database.Data[fmtDate(database.lastDate)].data, updatedRecord);
    const theTable = WMHTML('table#main_table_countries_today').children('tbody').children('tr:not(.row_continent)');
    theTable.each((i, el) => {
        // get our stuff
        let country = null;
        cheerio(el).children('td').each((tdi, tdel) => {
            if(tdi > 1 && country == null) return;
            switch(tdi) {
                case 1:
                    if(database.Data[fmtDate(database.lastDate)].children[localeFix(cheerio(tdel).find('a').text().trim())] !== undefined) {
                        country = database.Data[fmtDate(database.lastDate)].children[localeFix(cheerio(tdel).find('a').text().trim())];
                    }
                    break;
                case 2:
                    country.data.TotalConfirmed = parseInt(cheerio(tdel).text().trim().replace(/,/g, '')) || 0;
                    break;
                case 4:
                    country.data.TotalDeaths = parseInt(cheerio(tdel).text().trim().replace(/,/g, '')) || 0;
                    break;
                case 6:
                    country.data.TotalRecovered = parseInt(cheerio(tdel).text().trim().replace(/,/g, '')) || 0;
                    break;
                case 8:
                    country.data.TotalActive = parseInt(cheerio(tdel).text().trim().replace(/,/g, '')) || 0;
                    break;
            }
        });
    });
    console.log('Data loaded.');
}

refreshDB(true);
setInterval(() => refreshDB(), 1000 * 60 * 15); // refresh DB every 15 mins for that real time juice

// API

const errorSnippet = (s, children) => {
    if(s == null) return {error: 'NOT_FOUND'};
    else return s.format(children);
}

app.get('/summary', (req, res) => {
    res.json(database.lookupTotal().format(0));
});

app.get('/summary/countries', (req, res) => {
    res.json(database.lookupTotal().format(1));
});

app.get('/summary/countries/:start/:end?', (req, res) => {
    if(!validateDate(req.params.start) || (req.params.end && !validateDate(req.params.end))) {
        res.json({error: 'INVALID_DATE'});
        return;
    }
    res.json(database.tsTotal(new Date(req.params.start), req.params.end && new Date(req.params.end)).map((a) => Object.assign({date: a.date}, a.rec.format(1))));
});

app.get('/summary/:start/:end?', (req, res) => {
    if(!validateDate(req.params.start) || (req.params.end && !validateDate(req.params.end))) {
        res.json({error: 'INVALID_DATE'});
        return;
    }
    res.json(database.tsTotal(new Date(req.params.start), req.params.end && new Date(req.params.end)).map((a) => Object.assign({date: a.date}, a.rec.format(0))));
});

app.get('/country/:country', (req, res) => {
    res.json(errorSnippet(database.lookupCountry(req.params.country), 1));
});

app.get('/country/:country/state/:state', (req, res) => {
    res.json(errorSnippet(database.lookupLocality(req.params.country, req.params.state), 1));
});

app.get('/country/:country/:start/:end?', (req, res) => {
    if(!validateDate(req.params.start) || (req.params.end && !validateDate(req.params.end))) {
        res.json({error: 'INVALID_DATE'});
        return;
    }
    res.json(database.tsCountry(req.params.country, new Date(req.params.start), req.params.end && new Date(req.params.end)).map((a) => Object.assign({date: a.date}, a.rec.format(0))));
});

app.get('/country/:country/state/:state/:start/:end?', (req, res) => {
    if(!validateDate(req.params.start) || (req.params.end && !validateDate(req.params.end))) {
        res.json({error: 'INVALID_DATE'});
        return;
    }
    res.json(database.tsLocality(req.params.country, req.params.state, new Date(req.params.start), req.params.end && new Date(req.params.end)).map((a) => Object.assign({date: a.date}, a.rec.format(0))));
});

app.listen(80);