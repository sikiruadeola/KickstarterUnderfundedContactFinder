FROM apify/actor-node-playwright-chrome:20

COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed dependencies:" \
    && npm list --omit=dev --all || true

COPY . ./

CMD npm start --silent
