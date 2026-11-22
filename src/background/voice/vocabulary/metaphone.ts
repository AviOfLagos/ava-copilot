/**
 * Double Metaphone (Lawrence Philips, 2000): a code for how an English word sounds, so that "Illum", "Elum" and
 * "Ellum" share one. Written here from the published rules rather than taken from a package, because the
 * correction needs only the code of a single word and a dependency for that is more than it is worth.
 *
 * Returns the primary and the alternate code, each up to four characters. The correction compares the primary
 * codes; the alternate is returned for completeness and for tests of the rules.
 */

const VOWELS = 'AEIOUY';

function stringAt(word: string, start: number, length: number, list: string[]): boolean {
  if (start < 0 || start >= word.length) return false;
  const part = word.substr(start, length);
  return list.includes(part);
}

export function doubleMetaphone(input: string): { primary: string; secondary: string } {
  const letters = input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  const length = letters.length;
  const last = length - 1;
  // As in the published rules, the word is followed by spaces, which some rules look for ("JOSE ", "IER ")
  const word = `${letters}     `;
  const at = (i: number) => (i >= 0 && i < word.length ? word[i] : '');
  const isVowel = (i: number) => i >= 0 && i < length && VOWELS.includes(word[i]);
  const slavoGermanic = /W|K|CZ|WITZ/.test(letters);

  let primary = '';
  let secondary = '';
  const add = (main: string, alt = main) => {
    primary += main;
    secondary += alt;
  };

  let current = 0;
  if (stringAt(word, 0, 2, ['GN', 'KN', 'PN', 'WR', 'PS'])) current = 1;
  if (at(0) === 'X') {
    add('S');
    current = 1;
  }

  while ((primary.length < 4 || secondary.length < 4) && current < length) {
    const c = at(current);
    switch (c) {
      case 'A':
      case 'E':
      case 'I':
      case 'O':
      case 'U':
      case 'Y':
        if (current === 0) add('A');
        current += 1;
        break;

      case 'B':
        add('P');
        current += at(current + 1) === 'B' ? 2 : 1;
        break;

      case 'C':
        // Various Germanic
        if (
          current > 1 &&
          !isVowel(current - 2) &&
          stringAt(word, current - 1, 3, ['ACH']) &&
          at(current + 2) !== 'I' &&
          (at(current + 2) !== 'E' || stringAt(word, current - 2, 6, ['BACHER', 'MACHER']))
        ) {
          add('K');
          current += 2;
          break;
        }
        // Special case "caesar"
        if (current === 0 && stringAt(word, current, 6, ['CAESAR'])) {
          add('S');
          current += 2;
          break;
        }
        // Italian "chianti"
        if (stringAt(word, current, 4, ['CHIA'])) {
          add('K');
          current += 2;
          break;
        }
        if (stringAt(word, current, 2, ['CH'])) {
          // "michael"
          if (current > 0 && stringAt(word, current, 4, ['CHAE'])) {
            add('K', 'X');
            current += 2;
            break;
          }
          // Greek roots ("chemistry", "chorus")
          if (
            current === 0 &&
            (stringAt(word, current + 1, 5, ['HARAC', 'HARIS']) ||
              stringAt(word, current + 1, 3, ['HOR', 'HYM', 'HIA', 'HEM'])) &&
            !stringAt(word, 0, 5, ['CHORE'])
          ) {
            add('K');
            current += 2;
            break;
          }
          // Germanic, Greek, or otherwise "CH" for "KH" sound
          if (
            stringAt(word, 0, 4, ['VAN ', 'VON ']) ||
            stringAt(word, 0, 3, ['SCH']) ||
            stringAt(word, current - 2, 6, ['ORCHES', 'ARCHIT', 'ORCHID']) ||
            stringAt(word, current + 2, 1, ['T', 'S']) ||
            ((stringAt(word, current - 1, 1, ['A', 'O', 'U', 'E']) || current === 0) &&
              stringAt(word, current + 2, 1, ['L', 'R', 'N', 'M', 'B', 'H', 'F', 'V', 'W', ' ']))
          ) {
            add('K');
          } else if (current > 0) {
            if (stringAt(word, 0, 2, ['MC'])) add('K');
            else add('X', 'K');
          } else {
            add('X');
          }
          current += 2;
          break;
        }
        // "czerny"
        if (stringAt(word, current, 2, ['CZ']) && !stringAt(word, current - 2, 4, ['WICZ'])) {
          add('S', 'X');
          current += 2;
          break;
        }
        // "focaccia"
        if (stringAt(word, current + 1, 3, ['CIA'])) {
          add('X');
          current += 3;
          break;
        }
        // Double "C", but not "McClellan"
        if (stringAt(word, current, 2, ['CC']) && !(current === 1 && at(0) === 'M')) {
          // "bellocchio", but not "bacchus"
          if (stringAt(word, current + 2, 1, ['I', 'E', 'H']) && !stringAt(word, current + 2, 2, ['HU'])) {
            // "accident", "accede", "succeed"
            if ((current === 1 && at(current - 1) === 'A') || stringAt(word, current - 1, 5, ['UCCEE', 'UCCES'])) {
              add('KS');
            } else {
              add('X');
            }
            current += 3;
            break;
          }
          // Pierce's rule
          add('K');
          current += 2;
          break;
        }
        if (stringAt(word, current, 2, ['CK', 'CG', 'CQ'])) {
          add('K');
          current += 2;
          break;
        }
        if (stringAt(word, current, 2, ['CI', 'CE', 'CY'])) {
          // Italian vs. English
          if (stringAt(word, current, 3, ['CIO', 'CIE', 'CIA'])) add('S', 'X');
          else add('S');
          current += 2;
          break;
        }
        add('K');
        // "mac caffrey", "mac gregor"
        if (stringAt(word, current + 1, 2, [' C', ' Q', ' G'])) current += 3;
        else if (stringAt(word, current + 1, 1, ['C', 'K', 'Q']) && !stringAt(word, current + 1, 2, ['CE', 'CI']))
          current += 2;
        else current += 1;
        break;

      case 'D':
        if (stringAt(word, current, 2, ['DG'])) {
          if (stringAt(word, current + 2, 1, ['I', 'E', 'Y'])) {
            // "edge"
            add('J');
            current += 3;
          } else {
            // "edgar"
            add('TK');
            current += 2;
          }
          break;
        }
        if (stringAt(word, current, 2, ['DT', 'DD'])) {
          add('T');
          current += 2;
          break;
        }
        add('T');
        current += 1;
        break;

      case 'F':
        add('F');
        current += at(current + 1) === 'F' ? 2 : 1;
        break;

      case 'G':
        if (at(current + 1) === 'H') {
          if (current > 0 && !isVowel(current - 1)) {
            add('K');
            current += 2;
            break;
          }
          if (current === 0) {
            // "ghislane", "ghiradelli"
            add(at(current + 2) === 'I' ? 'J' : 'K');
            current += 2;
            break;
          }
          // Parker's rule (with some further refinements): "hugh", "bough", "broughton"
          if (
            (current > 1 && stringAt(word, current - 2, 1, ['B', 'H', 'D'])) ||
            (current > 2 && stringAt(word, current - 3, 1, ['B', 'H', 'D'])) ||
            (current > 3 && stringAt(word, current - 4, 1, ['B', 'H']))
          ) {
            current += 2;
            break;
          }
          // "laugh", "McLaughlin", "cough", "gough", "rough", "tough"
          if (current > 2 && at(current - 1) === 'U' && stringAt(word, current - 3, 1, ['C', 'G', 'L', 'R', 'T'])) {
            add('F');
          } else if (current > 0 && at(current - 1) !== 'I') {
            add('K');
          }
          current += 2;
          break;
        }
        if (at(current + 1) === 'N') {
          if (current === 1 && isVowel(0) && !slavoGermanic) add('KN', 'N');
          // Not "cagney"
          else if (!stringAt(word, current + 2, 2, ['EY']) && at(current + 1) !== 'Y' && !slavoGermanic) add('N', 'KN');
          else add('KN');
          current += 2;
          break;
        }
        // "tagliaro"
        if (stringAt(word, current + 1, 2, ['LI']) && !slavoGermanic) {
          add('KL', 'L');
          current += 2;
          break;
        }
        // -ges-, -gep-, -gel- at the beginning
        if (
          current === 0 &&
          (at(current + 1) === 'Y' ||
            stringAt(word, current + 1, 2, ['ES', 'EP', 'EB', 'EL', 'EY', 'IB', 'IL', 'IN', 'IE', 'EI', 'ER']))
        ) {
          add('K', 'J');
          current += 2;
          break;
        }
        // -ger-, -gy-
        if (
          (stringAt(word, current + 1, 2, ['ER']) || at(current + 1) === 'Y') &&
          !stringAt(word, 0, 6, ['DANGER', 'RANGER', 'MANGER']) &&
          !stringAt(word, current - 1, 1, ['E', 'I']) &&
          !stringAt(word, current - 1, 3, ['RGY', 'OGY'])
        ) {
          add('K', 'J');
          current += 2;
          break;
        }
        // Italian "biaggi"
        if (stringAt(word, current + 1, 1, ['E', 'I', 'Y']) || stringAt(word, current - 1, 4, ['AGGI', 'OGGI'])) {
          // Obvious Germanic
          if (
            stringAt(word, 0, 4, ['VAN ', 'VON ']) ||
            stringAt(word, 0, 3, ['SCH']) ||
            stringAt(word, current + 1, 2, ['ET'])
          ) {
            add('K');
          } else if (stringAt(word, current + 1, 4, ['IER '])) {
            add('J');
          } else {
            add('J', 'K');
          }
          current += 2;
          break;
        }
        add('K');
        current += at(current + 1) === 'G' ? 2 : 1;
        break;

      case 'H':
        // Only keep if first and before a vowel, or between two vowels
        if ((current === 0 || isVowel(current - 1)) && isVowel(current + 1)) {
          add('H');
          current += 2;
        } else {
          current += 1;
        }
        break;

      case 'J':
        // "jose", "san jacinto"
        if (stringAt(word, current, 4, ['JOSE']) || stringAt(word, 0, 4, ['SAN '])) {
          if ((current === 0 && at(current + 4) === ' ') || stringAt(word, 0, 4, ['SAN '])) add('H');
          else add('J', 'H');
          current += 1;
          break;
        }
        if (current === 0 && !stringAt(word, current, 4, ['JOSE'])) add('J', 'A');
        // Spanish pronunciation of "bajador"
        else if (isVowel(current - 1) && !slavoGermanic && (at(current + 1) === 'A' || at(current + 1) === 'O'))
          add('J', 'H');
        else if (current === last) add('J', '');
        else if (
          !stringAt(word, current + 1, 1, ['L', 'T', 'K', 'S', 'N', 'M', 'B', 'Z']) &&
          !stringAt(word, current - 1, 1, ['S', 'K', 'L'])
        )
          add('J');
        current += at(current + 1) === 'J' ? 2 : 1;
        break;

      case 'K':
        add('K');
        current += at(current + 1) === 'K' ? 2 : 1;
        break;

      case 'L':
        if (at(current + 1) === 'L') {
          // Spanish "cabrillo", "gallegos"
          if (
            (current === length - 3 && stringAt(word, current - 1, 4, ['ILLO', 'ILLA', 'ALLE'])) ||
            ((stringAt(word, last - 1, 2, ['AS', 'OS']) || stringAt(word, last, 1, ['A', 'O'])) &&
              stringAt(word, current - 1, 4, ['ALLE']))
          ) {
            add('L', '');
            current += 2;
            break;
          }
          current += 2;
        } else {
          current += 1;
        }
        add('L');
        break;

      case 'M':
        add('M');
        // "dumb", "thumb"
        if (
          (stringAt(word, current - 1, 3, ['UMB']) &&
            (current + 1 === last || stringAt(word, current + 2, 2, ['ER']))) ||
          at(current + 1) === 'M'
        )
          current += 2;
        else current += 1;
        break;

      case 'N':
        add('N');
        current += at(current + 1) === 'N' ? 2 : 1;
        break;

      case 'P':
        if (at(current + 1) === 'H') {
          add('F');
          current += 2;
          break;
        }
        add('P');
        // Also account for "campbell", "raspberry"
        current += stringAt(word, current + 1, 1, ['P', 'B']) ? 2 : 1;
        break;

      case 'Q':
        add('K');
        current += at(current + 1) === 'Q' ? 2 : 1;
        break;

      case 'R':
        // French "rogier", but exclude "hochmeier"
        if (
          current === last &&
          !slavoGermanic &&
          stringAt(word, current - 2, 2, ['IE']) &&
          !stringAt(word, current - 4, 2, ['ME', 'MA'])
        )
          add('', 'R');
        else add('R');
        current += at(current + 1) === 'R' ? 2 : 1;
        break;

      case 'S':
        // "island", "isle", "carlisle", "carlysle"
        if (stringAt(word, current - 1, 3, ['ISL', 'YSL'])) {
          current += 1;
          break;
        }
        // "sugar-"
        if (current === 0 && stringAt(word, current, 5, ['SUGAR'])) {
          add('X', 'S');
          current += 1;
          break;
        }
        if (stringAt(word, current, 2, ['SH'])) {
          // Germanic
          if (stringAt(word, current + 1, 4, ['HEIM', 'HOEK', 'HOLM', 'HOLZ'])) add('S');
          else add('X');
          current += 2;
          break;
        }
        // Italian and Armenian
        if (stringAt(word, current, 3, ['SIO', 'SIA']) || stringAt(word, current, 4, ['SIAN'])) {
          if (!slavoGermanic) add('S', 'X');
          else add('S');
          current += 3;
          break;
        }
        // German and anglicisations: "smith" matches "schmidt", "snider" matches "schneider"
        if (
          (current === 0 && stringAt(word, current + 1, 1, ['M', 'N', 'L', 'W'])) ||
          stringAt(word, current + 1, 1, ['Z'])
        ) {
          add('S', 'X');
          current += stringAt(word, current + 1, 1, ['Z']) ? 2 : 1;
          break;
        }
        if (stringAt(word, current, 2, ['SC'])) {
          // Schlesinger's rule
          if (at(current + 2) === 'H') {
            // Dutch origin, e.g. "school", "schooner"
            if (stringAt(word, current + 3, 2, ['OO', 'ER', 'EN', 'UY', 'ED', 'EM'])) {
              // "schermerhorn", "schenker"
              if (stringAt(word, current + 3, 2, ['ER', 'EN'])) add('X', 'SK');
              else add('SK');
              current += 3;
              break;
            }
            if (current === 0 && !isVowel(3) && at(3) !== 'W') add('X', 'S');
            else add('X');
            current += 3;
            break;
          }
          if (stringAt(word, current + 2, 1, ['I', 'E', 'Y'])) add('S');
          else add('SK');
          current += 3;
          break;
        }
        // French "resnais", "artois"
        if (current === last && stringAt(word, current - 2, 2, ['AI', 'OI'])) add('', 'S');
        else add('S');
        current += stringAt(word, current + 1, 1, ['S', 'Z']) ? 2 : 1;
        break;

      case 'T':
        if (stringAt(word, current, 4, ['TION'])) {
          add('X');
          current += 3;
          break;
        }
        if (stringAt(word, current, 3, ['TIA', 'TCH'])) {
          add('X');
          current += 3;
          break;
        }
        if (stringAt(word, current, 2, ['TH']) || stringAt(word, current, 3, ['TTH'])) {
          // "thomas", "thames"
          if (
            stringAt(word, current + 2, 2, ['OM', 'AM']) ||
            stringAt(word, 0, 4, ['VAN ', 'VON ']) ||
            stringAt(word, 0, 3, ['SCH'])
          ) {
            add('T');
          } else {
            add('0', 'T');
          }
          current += 2;
          break;
        }
        add('T');
        current += stringAt(word, current + 1, 1, ['T', 'D']) ? 2 : 1;
        break;

      case 'V':
        add('F');
        current += at(current + 1) === 'V' ? 2 : 1;
        break;

      case 'W':
        // Can also be in the middle of a word
        if (stringAt(word, current, 2, ['WR'])) {
          add('R');
          current += 2;
          break;
        }
        if (current === 0 && (isVowel(current + 1) || stringAt(word, current, 2, ['WH']))) {
          // "Wasserman" should match "Vasserman"
          if (isVowel(current + 1)) add('A', 'F');
          else add('A');
        }
        // "Arnow" should match "Arnoff"
        if (
          (current === last && isVowel(current - 1)) ||
          stringAt(word, current - 1, 5, ['EWSKI', 'EWSKY', 'OWSKI', 'OWSKY']) ||
          stringAt(word, 0, 3, ['SCH'])
        ) {
          add('', 'F');
          current += 1;
          break;
        }
        // Polish "filipowicz"
        if (stringAt(word, current, 4, ['WICZ', 'WITZ'])) {
          add('TS', 'FX');
          current += 4;
          break;
        }
        current += 1;
        break;

      case 'X':
        // French "breaux"
        if (!(
          current === last &&
          (stringAt(word, current - 3, 3, ['IAU', 'EAU']) || stringAt(word, current - 2, 2, ['AU', 'OU']))
        )) {
          add('KS');
        }
        current += stringAt(word, current + 1, 1, ['C', 'X']) ? 2 : 1;
        break;

      case 'Z':
        // Chinese pinyin "zhao"
        if (at(current + 1) === 'H') {
          add('J');
          current += 2;
          break;
        }
        if (
          stringAt(word, current + 1, 2, ['ZO', 'ZI', 'ZA']) ||
          (slavoGermanic && current > 0 && at(current - 1) !== 'T')
        ) {
          add('S', 'TS');
        } else {
          add('S');
        }
        current += at(current + 1) === 'Z' ? 2 : 1;
        break;

      default:
        current += 1;
    }
  }

  return { primary: primary.slice(0, 4), secondary: secondary.slice(0, 4) };
}
