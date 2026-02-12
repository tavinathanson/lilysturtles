#!/bin/bash
# Upload sample turtles to a running server
# Usage: ./test-turtles.sh [count]  (default: 5)

URL="http://localhost:3000/api/upload"
CODE="1234"
COUNT="${1:-5}"

# Each entry: name|svg_body
# Drawings are outlines/strokes on a white background, like kid sketches
samples=(
'Coral|
  <rect width="200" height="200" fill="white"/>
  <circle cx="100" cy="90" r="50" fill="none" stroke="salmon" stroke-width="3"/>
  <circle cx="85" cy="78" r="5" fill="none" stroke="salmon" stroke-width="2"/>
  <circle cx="115" cy="78" r="5" fill="none" stroke="salmon" stroke-width="2"/>
  <path d="M85 102 Q100 118 115 102" fill="none" stroke="salmon" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="60" y1="55" x2="50" y2="35" stroke="salmon" stroke-width="2" stroke-linecap="round"/>
  <line x1="140" y1="55" x2="150" y2="35" stroke="salmon" stroke-width="2" stroke-linecap="round"/>
  <path d="M30 160 Q50 140 70 160 Q90 140 110 160 Q130 140 150 160 Q170 140 190 160" fill="none" stroke="coral" stroke-width="2"/>'

'Bubbles|
  <rect width="200" height="200" fill="white"/>
  <circle cx="60" cy="70" r="25" fill="none" stroke="dodgerblue" stroke-width="2.5"/>
  <circle cx="130" cy="55" r="18" fill="none" stroke="steelblue" stroke-width="2"/>
  <circle cx="100" cy="130" r="35" fill="none" stroke="cornflowerblue" stroke-width="3"/>
  <circle cx="155" cy="120" r="12" fill="none" stroke="dodgerblue" stroke-width="2"/>
  <circle cx="45" cy="145" r="15" fill="none" stroke="steelblue" stroke-width="2"/>
  <circle cx="160" cy="165" r="8" fill="none" stroke="cornflowerblue" stroke-width="1.5"/>'

'Sunny|
  <rect width="200" height="200" fill="white"/>
  <circle cx="100" cy="100" r="35" fill="none" stroke="orange" stroke-width="3"/>
  <line x1="100" y1="55" x2="100" y2="30" stroke="gold" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="100" y1="145" x2="100" y2="170" stroke="gold" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="55" y1="100" x2="30" y2="100" stroke="gold" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="145" y1="100" x2="170" y2="100" stroke="gold" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="68" y1="68" x2="50" y2="50" stroke="gold" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="132" y1="68" x2="150" y2="50" stroke="gold" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="68" y1="132" x2="50" y2="150" stroke="gold" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="132" y1="132" x2="150" y2="150" stroke="gold" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="88" cy="92" r="4" fill="none" stroke="orange" stroke-width="2"/>
  <circle cx="112" cy="92" r="4" fill="none" stroke="orange" stroke-width="2"/>
  <path d="M88 110 Q100 120 112 110" fill="none" stroke="orange" stroke-width="2" stroke-linecap="round"/>'

'Clover|
  <rect width="200" height="200" fill="white"/>
  <circle cx="100" cy="65" r="25" fill="none" stroke="green" stroke-width="2.5"/>
  <circle cx="78" cy="100" r="25" fill="none" stroke="forestgreen" stroke-width="2.5"/>
  <circle cx="122" cy="100" r="25" fill="none" stroke="seagreen" stroke-width="2.5"/>
  <line x1="100" y1="120" x2="100" y2="175" stroke="green" stroke-width="3" stroke-linecap="round"/>
  <path d="M100 155 Q120 140 130 150" fill="none" stroke="green" stroke-width="2" stroke-linecap="round"/>'

'Violet|
  <rect width="200" height="200" fill="white"/>
  <path d="M100 40 L115 80 L160 80 L125 105 L138 145 L100 120 L62 145 L75 105 L40 80 L85 80 Z" fill="none" stroke="mediumpurple" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="100" cy="95" r="8" fill="none" stroke="plum" stroke-width="2"/>
  <circle cx="60" cy="160" r="5" fill="none" stroke="violet" stroke-width="1.5"/>
  <circle cx="145" cy="170" r="4" fill="none" stroke="orchid" stroke-width="1.5"/>
  <circle cx="35" cy="40" r="3" fill="none" stroke="plum" stroke-width="1.5"/>'

'Ruby|
  <rect width="200" height="200" fill="white"/>
  <path d="M100 45 C130 45 155 70 155 100 C155 135 130 160 100 160 C70 160 45 135 45 100 C45 70 70 45 100 45" fill="none" stroke="crimson" stroke-width="3"/>
  <path d="M100 60 L105 90 L100 85 L95 90 Z" fill="none" stroke="crimson" stroke-width="2"/>
  <path d="M80 100 Q100 130 120 100" fill="none" stroke="tomato" stroke-width="2" stroke-linecap="round"/>
  <line x1="80" y1="85" x2="72" y2="78" stroke="crimson" stroke-width="2" stroke-linecap="round"/>
  <line x1="120" y1="85" x2="128" y2="78" stroke="crimson" stroke-width="2" stroke-linecap="round"/>
  <path d="M60 170 Q80 155 100 170 Q120 155 140 170" fill="none" stroke="pink" stroke-width="2"/>'

'Ocean|
  <rect width="200" height="200" fill="white"/>
  <path d="M20 80 Q50 60 80 80 Q110 100 140 80 Q170 60 200 80" fill="none" stroke="teal" stroke-width="2.5"/>
  <path d="M0 110 Q30 90 60 110 Q90 130 120 110 Q150 90 180 110" fill="none" stroke="darkcyan" stroke-width="2.5"/>
  <path d="M20 140 Q50 120 80 140 Q110 160 140 140 Q170 120 200 140" fill="none" stroke="cadetblue" stroke-width="2"/>
  <ellipse cx="60" cy="55" rx="12" ry="8" fill="none" stroke="teal" stroke-width="1.5"/>
  <ellipse cx="150" cy="50" rx="8" ry="5" fill="none" stroke="teal" stroke-width="1.5"/>
  <polygon points="90,155 100,175 110,155" fill="none" stroke="darkcyan" stroke-width="2"/>'

'Mango|
  <rect width="200" height="200" fill="white"/>
  <ellipse cx="100" cy="95" rx="55" ry="45" fill="none" stroke="darkorange" stroke-width="3"/>
  <path d="M100 50 Q110 30 130 25 Q120 40 115 55" fill="none" stroke="green" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M75 80 Q100 75 125 80" fill="none" stroke="orange" stroke-width="1.5"/>
  <path d="M70 95 Q100 90 130 95" fill="none" stroke="orange" stroke-width="1.5"/>
  <path d="M75 110 Q100 105 125 110" fill="none" stroke="orange" stroke-width="1.5"/>
  <circle cx="55" cy="160" r="6" fill="none" stroke="darkorange" stroke-width="1.5"/>
  <circle cx="150" cy="165" r="4" fill="none" stroke="darkorange" stroke-width="1.5"/>'

'Berry|
  <rect width="200" height="200" fill="white"/>
  <circle cx="80" cy="75" r="28" fill="none" stroke="blueviolet" stroke-width="2.5"/>
  <circle cx="120" cy="75" r="28" fill="none" stroke="darkviolet" stroke-width="2.5"/>
  <circle cx="100" cy="110" r="28" fill="none" stroke="purple" stroke-width="2.5"/>
  <path d="M85 55 Q100 30 115 55" fill="none" stroke="green" stroke-width="2" stroke-linecap="round"/>
  <line x1="100" y1="42" x2="100" y2="25" stroke="green" stroke-width="2" stroke-linecap="round"/>
  <circle cx="40" cy="160" r="10" fill="none" stroke="hotpink" stroke-width="1.5"/>
  <circle cx="165" cy="155" r="7" fill="none" stroke="hotpink" stroke-width="1.5"/>'

'Jade|
  <rect width="200" height="200" fill="white"/>
  <polygon points="100,30 170,80 145,160 55,160 30,80" fill="none" stroke="seagreen" stroke-width="3" stroke-linejoin="round"/>
  <polygon points="100,55 145,90 130,140 70,140 55,90" fill="none" stroke="mediumseagreen" stroke-width="2" stroke-linejoin="round"/>
  <polygon points="100,75 125,100 115,125 85,125 75,100" fill="none" stroke="lightseagreen" stroke-width="1.5" stroke-linejoin="round"/>
  <circle cx="100" cy="100" r="5" fill="none" stroke="seagreen" stroke-width="1.5"/>'
)

for i in $(seq 0 $(($COUNT - 1))); do
  entry="${samples[$((i % ${#samples[@]}))]}"
  name="${entry%%|*}"
  body="${entry#*|}"

  svg="<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'>$body</svg>"

  tmp=$(mktemp /tmp/turtle_XXXX.svg)
  echo "$svg" > "$tmp"

  echo -n "Uploading $name... "
  curl -s -X POST "$URL" \
    -F "eventCode=$CODE" \
    -F "name=$name" \
    -F "photo=@$tmp;type=image/svg+xml" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success','FAIL'))" 2>/dev/null || echo "FAIL"

  rm "$tmp"
done

echo "Done!"
