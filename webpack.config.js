const webpack = require('webpack');

module.exports = {
  entry: './src/log.js',
  output: {
    libraryTarget: 'var',
    library: 'Log',
    filename: './dist/ipfslog.min.js'
  },
  node: {
    console: false,
    process: 'mock',
    Buffer: 'buffer'
  },
  plugins: [
    new webpack.optimize.UglifyJsPlugin({
      mangle: true,
      compress: { warnings: false }
    })
  ],
  module: {
    loaders: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        loader: 'babel',
        query: {
          presets: ['es2015']
        }
      }
    ]
  }
};
