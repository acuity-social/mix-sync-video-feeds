import levelup from 'levelup'
import leveldown from 'leveldown'
import { exec, spawn } from 'child_process'
import { load } from 'protobufjs'
import { brotliCompressSync } from 'zlib'
import Web3 from 'web3'
import net from 'net'
import * as bip32 from 'bip32'
import * as bip39  from 'bip39'
import bs58 from 'bs58'
import { request } from 'http'
import sharp from 'sharp'

let db
let web3: any

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
    exec('youtube-dl --write-thumbnail --print-json --id --merge-output-format mkv https://www.youtube.com/watch?v=' + id, (error, stdout, stderr) => {
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

function ipfsAddFile(filename: string): Promise<string> {
  return new Promise(async (resolve, reject) => {
    let args = ['add', '-Q', '--raw-leaves', filename]
    let ipfsProcess = spawn('ipfs', args)

    ipfsProcess.stdout.on('data', (data) => {
      resolve(data.toString().trim())
    })

    ipfsProcess.stderr.on('data', (data) => {
      reject(data.toString())
    })
  })
}

function ipfsAdd(data: Buffer, encoding: string = 'binary'): Promise<any> {
  return new Promise((resolve, reject) => {
    let boundary = web3.utils.randomHex(32)

    let options = {
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
      },
      method: 'POST',
      path: '/api/v0/add',
      port: process.env.IPFS_PORT,
    }

    let postData = '--' + boundary + '\r\n'
    postData += 'Content-Disposition: form-data"\r\n'
    postData += 'Content-Type: application/octet-stream\r\n\r\n'
    postData += data.toString('binary')
    postData += '\r\n--' + boundary + '--\r\n'

    let req = request(options)
    .on('response', res => {
      let body = ''
      res.on('data', data => {
        body += data
      })
      res.on('end', () => {
        resolve(JSON.parse(body))
      })
    })
    .on('error', (error) => {
      reject(error)
    })

    req.write(postData, encoding);
    req.end();
  })
}

function getImageMixinMessage(id: string) {
  return new Promise(async (resolve, reject) => {
    let imageMixinProtoRoot = await load('./src/protobuf/ImageMixin.proto')
    let imageMixinProto = imageMixinProtoRoot.lookupType('ImageMixin')
    let mipmapLevelProto = imageMixinProtoRoot.lookupType('MipmapLevel')

    // Use SIMD instructions if available.
    sharp.simd(true)
    let source = sharp(id + '.jpg')
      .rotate()             // Rotate/flip the image if specified in EXIF.

    let metadata: any = await source.metadata()
    // Work out correct dimensions if rotation occured.
    let width, height
    if (metadata.orientation > 4) {
      width = metadata.height
      height = metadata.width
    }
    else {
      width = metadata.width
      height = metadata.height
    }

    let mipmaps = []
    // Don't resize the top-level mipmap.
    mipmaps.push(source
      .clone()
      .jpeg()
      .toBuffer()
      .then(data => {
        return ipfsAdd(data)
      })
    )

    let level = 1, outWidth, outHeight
    do {
      let scale = 2 ** level
      outWidth = Math.round(width / scale)
      outHeight = Math.round(height / scale)
      mipmaps.push(source
        .clone()
        .resize(outWidth, outHeight, {fit: 'fill', fastShrinkOnLoad: false})
        .jpeg()
        .toBuffer()
        .then(data => {
          return ipfsAdd(data)
        })
      )
      level++
    }
    while (outWidth > 64 && outHeight > 64)

    let levels: any[] = []

    for (let mipmap of await Promise.all(mipmaps)) {
      levels.push(mipmapLevelProto.create({
        filesize: mipmap.Size,
        ipfsHash: bs58.decode(mipmap.Hash),
      }))
    }

    resolve(imageMixinProto.encode(imageMixinProto.create({mipmap_level: levels})).finish())
  })
}

function getVideoMixinMessage(id: string) {
  return new Promise(async (resolve, reject) => {
    let videoMixinProtoRoot = await load('./src/protobuf/VideoMixin.proto')
    let videoMixinProto = videoMixinProtoRoot.lookupType('VideoMixin')
    let encodingProto = videoMixinProtoRoot.lookupType('Encoding')

    let result: any = await interrogate(id)

    let encodings: any[] = []

    for (let job of result.jobs) {
      await transcode(job)
      let ipfsHash: string = await ipfsAddFile(job.height + '.mp4')
      console.log(ipfsHash)

      encodings.push(encodingProto.create({
        ipfsHash: bs58.decode(ipfsHash),
        width: job.width,
        height: job.height,
      }))

      break
    }

    resolve(videoMixinProto.encode(videoMixinProto.create({encoding: encodings})).finish())
  })
}

async function start() {
  web3 = new Web3(new Web3.providers.IpcProvider(process.env.MIX_IPC_PATH!, net))
  console.log('Block:', (await web3.eth.getBlockNumber()).toLocaleString())

  // Calculate private key and controller address.
  let node: bip32.BIP32Interface = bip32.fromSeed(await bip39.mnemonicToSeed(process.env.RECOVERY_PHRASE!))
  let privateKey: string = '0x' + node.derivePath("m/44'/76'/0'/0/0").privateKey!.toString('hex')
  let controllerAddress: string = web3.eth.accounts.privateKeyToAccount(privateKey).address
  console.log('Controller address: ', controllerAddress)

  // Lookup contract address on blockchain.
  let accountRegistry = new web3.eth.Contract(require('./contracts/MixAccountRegistry.abi.json'), '0xbcab5026b4d79396b222abc4d1ca36db10984c73')
  let contractAddress: string = await accountRegistry.methods.get(controllerAddress).call()
  console.log('Contract address: ', contractAddress)

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

  let titleMixinMessage = titleMixinProto.encode(titleMixinProto.create({title: info.title})).finish()
  let bodyTextMixinMessage = bodyTextMixinProto.encode(bodyTextMixinProto.create({bodyText: info.description})).finish()

  let imageMixinMessage = await getImageMixinMessage(id)
  let videoMixinMessage = await getVideoMixinMessage(id)

  let itemMessage = itemProto.encode(itemProto.create({mixinPayload: [
    mixinPayloadProto.create({ mixinId: 0x344f4812, payload: titleMixinMessage }),
    mixinPayloadProto.create({ mixinId: 0x2d382044, payload: bodyTextMixinMessage }),
    mixinPayloadProto.create({ mixinId: 0x045eee8c, payload: imageMixinMessage }),
    mixinPayloadProto.create({ mixinId: 0x51108feb, payload: videoMixinMessage }),
  ]})).finish()

  let payload = brotliCompressSync(itemMessage)

  let ipfsInfo = await ipfsAdd(payload, 'utf8')
  console.log(ipfsInfo)
  db.put('lastId', id)
}

start()
