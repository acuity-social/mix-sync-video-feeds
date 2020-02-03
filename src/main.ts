import { exec } from 'child_process'

async function getId(): Promise<string> {
  return new Promise((resolve, reject) => {
    exec('youtube-dl --dump-single-json --playlist-end 2 --flat-playlist "' + process.env.FEED_SOURCE_URI + '"', (error, stdout, stderr) => {
      if (error) {
        reject (error)
      }
      let output = JSON.parse(stdout)
      resolve(output.entries[0].id)
    })
  })
}

async function download(id: string) {
  return new Promise((resolve, reject) => {
    exec('youtube-dl --quiet --id --merge-output-format mkv https://www.youtube.com/watch?v=' + id, (error, stdout, stderr) => {
      if (error) {
        reject (error)
      }
      resolve()
    })
  })
}

function interrogate(id: string): Promise<object> {
  return new Promise((resolve, reject) => {
    exec('ffmpeg -i ' + id + '.mkv', (error: Error | null, stdout, stderr) => {
      let output: string = error!.toString()
      let info: any = {}
      let matches: RegExpMatchArray = output.match(/Duration: (\d*):(\d*):(\d*)\./)!
      info.duration = (parseInt(matches[1]) * 60 + parseInt(matches[2])) * 60 + parseInt(matches[3])
      matches = output.match(/Video: .*, (\d*)x(\d*).*, ([0-9.]*) fps, /)!
      info.width = parseInt(matches[1])
      info.height = parseInt(matches[2])
      info.frameRate = parseFloat(matches[3])
      matches = output.match(/Video: (\w*)/)!
      info.codecVideo = matches[1]
      matches = output.match(/Audio: (\w*)/)!
      info.codecAudio = matches[1]
      resolve(info)
    })
  })
}

async function start() {
  let id:string = await getId()
  console.log(id)
  await download(id)
  let result: object = await interrogate(id)
  console.log(result)
}

start()
