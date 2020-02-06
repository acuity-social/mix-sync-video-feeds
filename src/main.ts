import levelup from 'levelup'
import leveldown from 'leveldown'
import { exec, spawn } from 'child_process'
import { load } from 'protobufjs'
import { brotliCompressSync } from 'zlib'
let Web3 = require('web3')
import * as net from 'net'

let db

function getId(): Promise<string> {
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

function download(id: string): Promise<any> {
  return new Promise((resolve, reject) => {
    exec('youtube-dl --print-json --id --merge-output-format mkv https://www.youtube.com/watch?v=' + id, (error, stdout, stderr) => {
      if (error) {
        reject (error)
      }
      resolve(JSON.parse(stdout))
    })
  })
}

function interrogate(id: string): Promise<any> {
  return new Promise((resolve, reject) => {
    let filepath: string = id + '.mkv'
    exec('ffmpeg -i ' + filepath, (error: Error | null, stdout, stderr) => {
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

      let supported_resolutions: number[] = [20, 40, 80, 120, 160, 240, 320, 480]
      let resolutions: number[] = []

      for (let b of supported_resolutions) {
        if (b * 9 <= info.height) {
          resolutions.push(b)
        }
        else {
          break
        }
      }

      info.jobs = []

      for (let b of resolutions) {
        let height = b * 9
        let width = (height * info.width) / info.height

        info.jobs.push({
          filepath: filepath,
          height: height,
          width: width,
          audioPassthrough: info.codecAudio == 'aac',
        })
      }

    })
  })
}

function h264Args(job: any) {
  let args: string[] = []

  args.push('-i')
  args.push(job.filepath)
  args.push('-c:v')
  args.push('libx264')
  args.push('-crf')
  args.push(process.env.H264_CRF!)
  args.push('-preset')
  args.push(process.env.H264_PRESET!)
  args.push('-vf')
  args.push('scale=' + job.width + ':' + job.height)
  args.push('-g')
  args.push('240')
  args.push('-c:a')
  if (job.audioPassthrough) {
    args.push('copy')
  }
  else {
    args.push('aac')
  }
  args.push('-movflags')
  args.push('+faststart')
  args.push('-y')
  args.push(job.height + '.mp4')

  return args
}

function transcode(job: any) {
  return new Promise((resolve, reject) => {
    let args: string[] = h264Args(job)
    let ffmpegProcess = spawn('ffmpeg', args)
    ffmpegProcess.stdout.on('data', (data) => {
      console.log(data.toString().trim())
    })

    ffmpegProcess.stderr.on('data', (data) => {
      console.log(data.toString().trim())
    })

    ffmpegProcess.on('close', resolve)
  })
}

function ipfsAdd(filename: string): Promise<string> {
  return new Promise(async (resolve, reject) => {
    let args = ['add', '-Q', '--raw-leaves', filename]
    let ipfsProcess = spawn('ipfs', args)

    ipfsProcess.stdout.on('data', (data) => {
      resolve(data.toString())
    })

    ipfsProcess.stderr.on('data', (data) => {
      reject(data.toString())
    })
  })
}

async function start() {
  let web3 = new Web3(new Web3.providers.IpcProvider(process.env.MIX_IPC_PATH!, net))
  console.log('Block:', (await web3.eth.getBlockNumber()).toLocaleString())

  db = levelup(leveldown('level.db'))
  let lastId: string = ''

  try {
    lastId = (await db.get('lastId')).toString()
    console.log('lastId:', lastId)
  }
  catch (e) {}

  let id:string = await getId()

  if (id == lastId) {
    return
  }

  console.log('id:', id)
  let info = await download(id)
  console.log('Title:', info.title)

  let itemProtoRoot = await load('./src/protobuf/Item.proto')
  let itemProto = itemProtoRoot.lookupType('Item')
  let mixinPayloadProto = itemProtoRoot.lookupType('MixinPayload')

  let titleMixinProtoRoot = await load('./src/protobuf/TitleMixin.proto')
  let titleMixinProto = titleMixinProtoRoot.lookupType('TitleMixin')

  let bodyTextMixinProtoRoot = await load('./src/protobuf/BodyTextMixin.proto')
  let bodyTextMixinProto = bodyTextMixinProtoRoot.lookupType('BodyTextMixin')

  let videoMixinProtoRoot = await load('./src/protobuf/VideoMixin.proto')
  let videoMixinProto = videoMixinProtoRoot.lookupType('VideoMixin')
  let encodingProto = videoMixinProtoRoot.lookupType('Encoding')

  let titleMixinMessage = titleMixinProto.encode(titleMixinProto.create({title: info.title})).finish()
  let bodyTextMixinMessage = bodyTextMixinProto.encode(bodyTextMixinProto.create({bodyText: info.description})).finish()

  let result: any = await interrogate(id)

  let encodings: any[] = []

  for (let job of result.jobs) {
    await transcode(job)
    let ipfsHash: string = await ipfsAdd(job.height + '.mp4')
    console.log(ipfsHash)

    encodings.push(encodingProto.create({
      ipfsHash: ipfsHash,
      width: job.width,
      height: job.height,
    }))

    break
  }

  let videoMixinMessage = videoMixinProto.encode(videoMixinProto.create({encoding: encodings})).finish()

  let itemMessage = itemProto.encode(itemProto.create({mixinPayload: [
    mixinPayloadProto.create({ mixinId: 0x344f4812, payload: titleMixinMessage }),
    mixinPayloadProto.create({ mixinId: 0x2d382044, payload: bodyTextMixinMessage }),
    mixinPayloadProto.create({ mixinId: 0x51108feb, payload: videoMixinMessage }),
  ]})).finish()

  let payload = brotliCompressSync(itemMessage)

  db.put('lastId', id)
}

start()
