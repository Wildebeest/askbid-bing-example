import {IncomingMessage, ServerResponse} from "http";

const http = require('http');
http.createServer(function (request: IncomingMessage, response: ServerResponse) {
  response.writeHead(200, {'Content-Type': 'text/plain'});
  response.end('Hello World\n');
}).listen(process.env.PORT);
