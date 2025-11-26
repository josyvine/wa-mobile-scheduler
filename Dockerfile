FROM node:18-slim

# 1. Install Google Chrome Stable and required system dependencies
# This is absolutely necessary for the WhatsApp library to run on the server
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    --no-install-recommends \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# 2. Create the folder for the app
WORKDIR /usr/src/app

# 3. Copy package files and install libraries
COPY package*.json ./
RUN npm install

# 4. Copy the rest of the application code
COPY . .

# 5. Set the port environment variable
ENV PORT=3000
EXPOSE 3000

# 6. Start the server
CMD [ "node", "server.js" ]