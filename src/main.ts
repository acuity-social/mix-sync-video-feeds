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
import EthCommon from 'ethereumjs-common'
import { Transaction as EthTx } from 'ethereumjs-tx'
let multihashes = require('multihashes')
import fs from 'fs'

let mixCommon = EthCommon.forCustomChain(
  'mainnet',
  {
    name: 'mix',
    networkId: 76,
    chainId: 76,
  },
  'byzantium',
)

let db: any
let web3: any
let accountRegistry: any
let itemDagFeedItems: any
let itemStoreAddress: string = '0x26b10bb026700148962c4a948b08ae162d18c0af'
let itemStoreIpfsSha256: any
let accountControllerAddress: string
let accountContractAddress: string
let accountContract: any
let privateKey: string

function getIds(i: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    exec('youtube-dl --cookies ' + process.env.FEED_ID! + '.cookies --dump-single-json --playlist-start ' + (i + 1) + ' --playlist-end ' + (i + 2) + ' --flat-playlist "' + process.env.FEED_SOURCE_URI + '"', (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      let output = JSON.parse(stdout)
      resolve([output.entries[0].id, output.entries[1].id])
    })
  })
}

async function getFirstId(): Promise<string> {
  let ids: string[] = await getIds(0)
  return ids[0]
}

async function getNextId(lastId: string): Promise<string> {
  let i: number = 0
  let ids: string[]

  do {
    ids = await getIds(i)
    if (ids[0] == lastId) {
      return ''
    }
    i++
  }
  while(ids[1] != lastId)
  return ids[0]
}

function download(id: string): Promise<any> {
  return new Promise((resolve, reject) => {
    exec('youtube-dl --cookies ' + process.env.FEED_ID! + '.cookies --write-thumbnail --print-json --id --merge-output-format mkv https://www.youtube.com/watch?v=' + id, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
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
      resolve(info)
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

    req.write(postData, encoding)
    req.end()
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
    fs.unlinkSync(id + '.jpg')

    resolve(imageMixinProto.encode(imageMixinProto.create({
      width: width,
      height: height,
      mipmapLevel: levels,
    })).finish())
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
      fs.unlinkSync(job.height + '.mp4')

      encodings.push(encodingProto.create({
        ipfsHash: bs58.decode(ipfsHash),
        width: job.width,
        height: job.height,
      }))
    }
    fs.unlinkSync(id + '.mkv')

    resolve(videoMixinProto.encode(videoMixinProto.create({
      duration: result.duration,
      encoding: encodings,
    })).finish())
  })
}

async function _send(transaction: any) {
  return new Promise(async (resolve, reject) => {
    let nonce = await web3.eth.getTransactionCount(accountControllerAddress)
    let data = await transaction.encodeABI()
    let rawTx = {
      nonce: nonce,
      from: accountControllerAddress,
      to: accountContractAddress,
      gasPrice: '0x3b9aca00',
      data: data,
      gas: 200000,
    }
    let tx = new EthTx(rawTx, { common: mixCommon })
    tx.sign(Buffer.from(privateKey.substr(2), 'hex'))
    let serializedTx = tx.serialize()
    web3.eth.sendSignedTransaction('0x' + serializedTx.toString('hex'))
    .on('error', reject)
    .on('transactionHash', (transactionHash: any) => {
      web3.eth.getTransaction(transactionHash)
      .then(resolve)
    })
  })
}

async function sendData(contract: any, method: string, params: any) {
  let to = contract.options.address
  let data = contract.methods[method](...params).encodeABI()
  let inner = accountContract.methods.sendCallNoReturn(to, data)
  return await _send(inner)
}

async function start() {
  web3 = new Web3(new Web3.providers.IpcProvider(process.env.MIX_IPC_PATH!, net))
  web3.eth.defaultBlock = 'pending'
  web3.eth.transactionConfirmationBlocks = 1
  console.log('Block:', (await web3.eth.getBlockNumber()).toLocaleString())

  accountRegistry = new web3.eth.Contract(require('./contracts/MixAccountRegistry.abi.json'), '0xbcab5026b4d79396b222abc4d1ca36db10984c73')
  itemDagFeedItems = new web3.eth.Contract(require('./contracts/MixItemDagOnlyOwner.abi.json'), '0x622d9bd5adf631c6e190f8d2beebcd5533ffa5e6')
  itemStoreIpfsSha256 = new web3.eth.Contract(require('./contracts/MixItemStoreIpfsSha256.abi.json'), itemStoreAddress)

  // Calculate private key and controller address.
  let node: bip32.BIP32Interface = bip32.fromSeed(await bip39.mnemonicToSeed(process.env.RECOVERY_PHRASE!))
  privateKey = '0x' + node.derivePath("m/44'/76'/0'/0/0").privateKey!.toString('hex')
  accountControllerAddress = web3.eth.accounts.privateKeyToAccount(privateKey).address
  console.log('Account controller address:', accountControllerAddress)

  // Lookup contract address on blockchain.
  accountContractAddress = await accountRegistry.methods.get(accountControllerAddress).call()
  console.log('Account contract address:', accountContractAddress)

  accountContract = new web3.eth.Contract(require('./contracts/MixAccount2.abi.json'), accountContractAddress)

  db = levelup(leveldown(process.env.FEED_ID! + '.db'))

  let checking: boolean = false

  setInterval(async () => {
    if (checking) {
      return
    }
    checking = true
    try {
      await check()
    }
    catch (e) {
      console.error(e)
    }
    checking = false
  }, 600000)
}

async function check() {
  let id: string = ''

  try {
    let lastId: string = (await db.get('lastId')).toString()
    id = await getNextId(lastId)
  }
  catch (e) {
    id = await getFirstId()
  }

  if (id == '') {
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

  let sourceUriMixinProtoRoot = await load('./src/protobuf/SourceUriMixin.proto')
  let sourceUriMixinProto = sourceUriMixinProtoRoot.lookupType('SourceUriMixin')

  let titleMixinMessage = titleMixinProto.encode(titleMixinProto.create({title: info.title})).finish()
  let bodyTextMixinMessage = bodyTextMixinProto.encode(bodyTextMixinProto.create({bodyText: info.description})).finish()

  let imageMixinMessage = await getImageMixinMessage(id)
  let videoMixinMessage = await getVideoMixinMessage(id)

  let sourceUriMixinMessage = sourceUriMixinProto.encode(sourceUriMixinProto.create({sourceUri: 'https://www.youtube.com/watch?v=' + id})).finish()

  let itemMessage = itemProto.encode(itemProto.create({mixinPayload: [
    mixinPayloadProto.create({ mixinId: 0x344f4812, payload: titleMixinMessage }),
    mixinPayloadProto.create({ mixinId: 0x2d382044, payload: bodyTextMixinMessage }),
    mixinPayloadProto.create({ mixinId: 0x045eee8c, payload: imageMixinMessage }),
    mixinPayloadProto.create({ mixinId: 0x51108feb, payload: videoMixinMessage }),
    mixinPayloadProto.create({ mixinId: 0x7b4c9e86, payload: sourceUriMixinMessage }),
  ]})).finish()

  let payload = brotliCompressSync(itemMessage)

  let ipfsInfo = await ipfsAdd(payload, 'utf8')
  let flagsNonce: string = '0x0f' + web3.utils.randomHex(31).substr(2)
  let itemId: string = await itemStoreIpfsSha256.methods.getNewItemId(accountContractAddress, flagsNonce).call()
  let decodedHash = multihashes.decode(multihashes.fromB58String(ipfsInfo.Hash))
  let feedId = '0x' + bs58.decode(process.env.FEED_ID!).toString('hex') + 'f1b5847865d2094d'
  await sendData(itemDagFeedItems, 'addChild', [feedId, itemStoreAddress, flagsNonce])
  await sendData(itemStoreIpfsSha256, 'create', [flagsNonce, '0x' + decodedHash.digest.toString('hex')])
  console.log('ItemId:', itemId)

  await db.put('lastId', id)
}

start()
