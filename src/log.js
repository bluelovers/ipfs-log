'use strict'

const unionWith = require('lodash.unionwith')
const differenceWith = require('lodash.differencewith')
const flatten = require('lodash.flatten')
const Lazy    = require('lazy.js')
const Promise = require('bluebird')
const Entry   = require('./entry')

const MaxBatchSize = 10  // How many items to keep per local batch
const MaxHistory   = 256 // How many items to fetch on join

class Log {
  constructor(ipfs, id, name, opts) {
    this.id = id
    this.name = name
    this._ipfs = ipfs
    this._items = opts && opts.items ? opts.items : []

    this.options = { maxHistory: MaxHistory }
    Object.assign(this.options, opts)
    delete this.options.items

    this._currentBatch = []
    this._heads = []
  }

  get items() {
    return this._items.concat(this._currentBatch)
  }

  get snapshot() {
    return {
      id: this.id,
      items: this._currentBatch.map((f) => f.hash)
    }
  }

  add(data) {
    if (this._currentBatch.length >= MaxBatchSize)
      this._commit()

    return Entry.create(this._ipfs, data, this._heads)
      .then((entry) => {
        this._heads = [entry.hash]
        this._currentBatch.push(entry)
        return entry
      })
  }

  join(other) {
    if (!other.items) throw new Error("The log to join must be an instance of Log")
    const newItems = other.items.slice(0, Math.max(this.options.maxHistory, 1))
    const diff     = differenceWith(newItems, this.items, Entry.equals)
    // TODO: need deterministic sorting for the union
    const final    = unionWith(this._currentBatch, diff, Entry.equals)
    this._items    = this._items.concat(final)
    this._currentBatch = []

    const nexts = Lazy(diff)
      .map((f) => f.next)
      .flatten()
      .take(this.options.maxHistory)
      .toArray()

    // Fetch history
    return Promise.map(nexts, (f) => {
      let all = this.items.map((a) => a.hash)
      return this._fetchRecursive(this._ipfs, f, all, this.options.maxHistory - nexts.length, 0)
        .then((history) => {
          history.forEach((b) => this._insert(b))
          return history
        })
    }, { concurrency: 1 }).then((res) => {
      this._heads = Log.findHeads(this)
      return flatten(res).concat(diff)
    })
  }

  _insert(entry) {
    let indices = Lazy(entry.next).map((next) => Lazy(this._items).map((f) => f.hash).indexOf(next)) // Find the item's parent's indices
    const index = indices.toArray().length > 0 ? Math.max(indices.max() + 1, 0) : 0 // find the largest index (latest parent)
    this._items.splice(index, 0, entry)
    return entry
  }

  _commit() {
    this._items = this._items.concat(this._currentBatch)
    this._currentBatch = []
  }

  _fetchRecursive(ipfs, hash, all, amount, depth) {
    const isReferenced = (list, item) => Lazy(list).reverse().find((f) => f === item) !== undefined
    let result = []

    // If the given hash is in the given log (all) or if we're at maximum depth, return
    if (isReferenced(all, hash) || depth >= amount)
      return Promise.resolve(result)

    // Create the entry and add it to the result
    return Entry.fromIpfsHash(ipfs, hash)
      .then((entry) => {
        result.push(entry)
        all.push(hash)
        depth ++

        return Promise.map(entry.next, (f) => this._fetchRecursive(ipfs, f, all, amount, depth), { concurrency: 1 })
          .then((res) => flatten(res.concat(result)))
      })
  }

  static getIpfsHash(ipfs, log) {
    if (!ipfs) throw new Error("Ipfs instance not defined")
    const data = new Buffer(JSON.stringify(log.snapshot))
    return ipfs.object.put(data)
      .then((res) => res.toJSON().Hash)
  }

  static fromIpfsHash(ipfs, hash, options) {
    if (!ipfs) throw new Error("Ipfs instance not defined")
    if (!hash) throw new Error("Invalid hash: " + hash)
    if (!options) options = {}
    let logData
    return ipfs.object.get(hash, { enc: 'base58' })
      .then((res) => logData = JSON.parse(res.toJSON().Data))
      .then((res) => {
        if (!logData.items) throw new Error("Not a Log instance")
        return Promise.all(logData.items.map((f) => Entry.fromIpfsHash(ipfs, f)))
      })
      .then((items) => Object.assign(options, { items: items }))
      .then((items) => new Log(ipfs, logData.id, '', options))
  }

  static findHeads(log) {
    return Lazy(log.items)
      .reverse()
      .filter((f) => !Log.isReferencedInChain(log, f))
      .map((f) => f.hash)
      .toArray()
  }

  static isReferencedInChain(log, item) {
    return Lazy(log.items).reverse().find((e) => e.hasChild(item)) !== undefined
  }

  static get batchSize() {
    return MaxBatchSize
  }
}

module.exports = Log
