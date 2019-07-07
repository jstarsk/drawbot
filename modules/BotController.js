let Gpio = require('pigpio').Gpio;
let cBezier = require('adaptive-bezier-curve');
let qBezier = require('adaptive-quadratic-curve');
let svgParse = require('svg-path-parser');
let arcToBezier = require('./arcToBezier');// copied from svg-arc-to-bezier npm library, because it uses es6 import instead of require

let BotController = (cfg) => {

    let bc = {};
    let config = cfg.data;


    /////////////////////////////////
    // MAIN SETUP VARIABLES
    bc._BOT_ID = config.botID; // || 'two'
    bc._DIRSWAP = config.swapDirections;// || true
    bc.baseDelay = config.baseDelay; // || 2
    bc._D = config.d; // || 1000// default distance between string starts
    bc.startPos = config.startPos;// || { x: 100, y: 100 }
    bc.stepsPerMM = config.stepsPerMM;// || [5000/500, 5000/500] // steps / mm
    bc.penPause = config.penPauseDelay;// || 200 // pause for pen up/down movement (in ms)


    /////////////////////////////////
    // GPIO SETUP
    let gmOut = {mode: Gpio.OUTPUT};
    let dirPins = [
        new Gpio(config.pins.leftDir, gmOut),
        new Gpio(config.pins.rightDir, gmOut)
    ];
    let stepPins = [
        new Gpio(config.pins.leftStep, gmOut),
        new Gpio(config.pins.rightStep, gmOut)
    ];
    // set up servo GPIO pin
    let servo = new Gpio(config.pins.penServo, gmOut);


    /////////////////////////////////
    // CONTROLLER VARIABLES

    // TODO: isolate private/public stuff

    bc.pos = {x: 0, y: 0};
    bc.penPos = 0;
    bc.paused = false;

    // string length stuff
    bc.startStringLengths = [0, 0];
    bc.stringLengths = [0, 0];
    bc.startSteps = [0, 0];
    bc.currentSteps = [0, 0];
    bc.stepCounts = [0, 0];
    bc.steppeds = [0, 0];
    bc.paths = [];
    bc.drawingPath = false;


    /////////////////////////////////
    // HARDWARE METHODS

    bc.updateStringLengths = () => {
        bc.startStringLengths = [
            Math.sqrt((bc.startPos.x * bc.startPos.x) + (bc.startPos.y * bc.startPos.y)),
            Math.sqrt(((bc._D - bc.startPos.x) * (bc._D - bc.startPos.x)) + (bc.startPos.y * bc.startPos.y))
        ];
        bc.stringLengths = [bc.startStringLengths[0], bc.startStringLengths[1]];
        bc.startSteps = [Math.round(bc.stringLengths[0] * bc.stepsPerMM[0]), Math.round(bc.stringLengths[1] * bc.stepsPerMM[1])];
        bc.currentSteps = [bc.startSteps[0], bc.startSteps[1]];

        console.log('bc.startPos', JSON.stringify(bc.startPos));
        console.log('startStringLengths', JSON.stringify(bc.startStringLengths));
        return bc.startStringLengths
    };

    bc.setStartPos = (data) => {
        cfg.data.startPos.x = bc.startPos.x = Number(data.x);// set values and store in config
        cfg.data.startPos.y = bc.startPos.y = Number(data.y);// set values and store in config
        cfg.save();// save to local config.json file
        bc.updateStringLengths()
    };
    bc.setD = (data) => {
        cfg.data.d = bc._D = Number(data);// set value and store in config
        cfg.save();// save to local config.json file
        bc.updateStringLengths()
    };

    bc.pen = (dir) => {
        bc.penPos = dir;
        // 0=down, 1=up
        // 544 to 2400
        let servoMin = 544;
        let servoMax = 2400;
        let servoD = servoMax - servoMin;
        let servoUpPos = servoMin + Math.floor(servoD * 0.35);
        let servoDnPos = servoMin;
        if (dir) {
            // lift pen up
            // console.log('up')
            servo.servoWrite(servoUpPos)
        } else {
            // put pen down
            // console.log('down')
            servo.servoWrite(servoDnPos)
            // servo.digitalWrite(0)
        }
    };
    bc.penThen = (dir, callback) => {
        if (dir !== bc.penPos) {
            bc.pen(dir);
            if (callback !== undefined) {
                setTimeout(callback, bc.penPause)
            }
        } else {
            callback()
        }
    };

    bc.makeStep = (m, d) => {
        // console.log('step',d)
        if (bc._DIRSWAP) d = !d;// swap direction if that setting is on
        dirPins[m].digitalWrite(d);
        stepPins[m].digitalWrite(1);
        setTimeout(function () {
            stepPins[m].digitalWrite(0)
        }, 1)
    };

    // TODO: This could move to a python script for faster execution (faster than bc.baseDelay=2 miliseconds)
    bc.rotateBoth = (s1, s2, d1, d2, callback) => {
        // console.log('bc.rotateBoth',s1,s2,d1,d2)
        let steps = Math.round(Math.max(s1, s2));
        let a1 = 0;
        let a2 = 0;
        let stepped = 0;

        let doStep = function () {
            if (!bc.paused) {
                setTimeout(function () {
                    // console.log(stepped,steps)
                    if (stepped < steps) {
                        stepped++;
                        // console.log('a1,a2',a1,a2)

                        a1 += s1;
                        if (a1 >= steps) {
                            a1 -= steps;
                            bc.makeStep(0, d1)
                        }

                        a2 += s2;
                        if (a2 >= steps) {
                            a2 -= steps;
                            bc.makeStep(1, d2)
                        }

                        doStep()

                    } else {
                        // console.log('bc.rotateBoth done!')
                        if (callback !== undefined) callback()
                    }
                }, bc.baseDelay)
            } else {
                // paused!
                console.log('paused!');
                bc.paused = false
            }
        };
        doStep()
    };

    bc.rotate = (motorIndex, dirIndex, delay, steps, callback) => {
        // console.log('bc.rotate',motorIndex, dirIndex, delay, steps)
        bc.stepCounts[motorIndex] = Math.round(steps);
        bc.steppeds[motorIndex] = 0;
        // let dir = (dirIndex==1) ? 0 : 1// reverses direction

        // doStep, then wait for delay d
        let doStep = function (d, m) {
            bc.makeStep(m, dirIndex);// changed to dirIndex from dir
            bc.steppeds[m]++;
            if (bc.steppeds[m] < bc.stepCounts[m]) {
                setTimeout(function () {
                    // console.log(m, bc.steppeds[m], "/", bc.stepCounts[m], d*bc.steppeds[m], "/", bc.stepCounts[m]*d)
                    doStep(d, m)
                }, d)
            } else {
                // done
                if (callback !== undefined) callback()
            }
        };
        doStep(delay, motorIndex)
    };


    /////////////////////////////////
    // DRAWING METHODS

    bc.moveTo = (x, y, callback, penDir = 1) => {
        // console.log('---------- bc.moveTo',x,y,' ----------')

        // convert x,y to l1,l2 (ideal, precise string lengths)
        let X = x + bc.startPos.x;
        let Y = y + bc.startPos.y;
        let X2 = X * X;
        let Y2 = Y * Y;
        let DsubX = bc._D - X;
        let DsubX2 = DsubX * DsubX;
        L1 = Math.sqrt(X2 + Y2);
        L2 = Math.sqrt(DsubX2 + Y2);

        // console.log('L:',L1,L2)

        // convert string lengths to motor steps (float to int)
        let s1 = Math.round(L1 * bc.stepsPerMM[0]);
        let s2 = Math.round(L2 * bc.stepsPerMM[1]);
        // console.log('s:',s1,s2)
        // console.log('bc.currentSteps:',bc.currentSteps[0],bc.currentSteps[1])

        // get difference between target steps and current steps (+/- int)
        let sd1 = s1 - bc.currentSteps[0];
        let sd2 = s2 - bc.currentSteps[1];
        // console.log('sd:',sd1,sd2)

        // get directions from steps difference
        let sdir1 = (sd1 > 0) ? 0 : 1;
        let sdir2 = (sd2 > 0) ? 1 : 0;
        // console.log('sdir:',sdir1,sdir2)

        // get steps with absolute value of steps difference
        let ssteps1 = Math.abs(sd1);
        let ssteps2 = Math.abs(sd2);

        // console.log('ssteps:',ssteps1,ssteps2)


        function doRotation() {
            // do the rotation!
            bc.rotateBoth(ssteps1, ssteps2, sdir1, sdir2, callback);

            // store new current steps
            bc.currentSteps[0] = s1;
            bc.currentSteps[1] = s2;

            // store new bc.pos
            bc.pos.x = x;
            bc.pos.y = y;
        }

        if (penDir !== 0) {
            // MOVETO (default)
            // pen up, then
            bc.penThen(1, doRotation);
        } else {
            // LINETO
            doRotation();
        }

    };

    bc.lineTo = (x, y, callback) => {
        // pen down, then

        bc.penThen(0, function () {
            bc.moveTo(Number(x), Number(y), callback, 0);// 0 makes bc.moveTo happen with pen down instead of up
        })
    };


    bc.addPath = (pathString) => {
        console.log('bc.addPath');
        bc.paths.push(pathString);
        console.log('pathcount: ', bc.paths.length);
        if (bc.paths.length === 1 && bc.drawingPath === false) {
            bc.drawNextPath();
        }
    };

    bc.pause = () => {
        bc.paused = true;
    };

    bc.drawNextPath = () => {
        if (bc.paths.length > 0) {
            bc.drawPath(bc.paths.shift());// return/remove first path from array
        } else {
            console.log("Done drawing all the paths. :)");
        }
    };

    bc.drawPath = (pathString) => {
        bc.drawingPath = true;
        console.log('drawing path...');
        let commands = svgParse(pathString);
        // let commands = pathString.split(/(?=[MmLlHhVvZz])/)
        let cmdCount = commands.length;
        console.log(cmdCount);
        let cmdIndex = 0;
        let prevCmd;

        function doCommand() {
            if (cmdIndex < cmdCount) {
                let cmd = commands[cmdIndex];
                let cmdCode = cmd.code;
                let tox = bc.pos.x;
                let toy = bc.pos.y;
                cmdIndex++;
                let percentage = Math.round((cmdIndex / cmdCount) * 100);
                console.log(cmd, percentage + '%');
                if (bc.client) bc.client.emit('progressUpdate', {
                    botID: bc._BOT_ID,
                    percentage: percentage
                });
                if (bc.localio) bc.localio.emit('progressUpdate', {
                    percentage: percentage
                });
                switch (cmdCode) {
                    case 'M':
                        // absolute move
                        tox = Number(cmd.x);
                        toy = Number(cmd.y);
                        bc.moveTo(Number(tox), Number(toy), doCommand);
                        break;
                    case 'L':
                        // absolute line
                        tox = Number(cmd.x);
                        toy = Number(cmd.y);
                        bc.lineTo(Number(tox), Number(toy), doCommand);
                        break;
                    case 'm':
                        // relative move
                        tox += Number(cmd.x);
                        toy += Number(cmd.y);
                        bc.moveTo(Number(tox), Number(toy), doCommand);
                        break;
                    case 'l':
                        // relative line
                        tox += Number(cmd.x);
                        toy += Number(cmd.y);
                        bc.lineTo(Number(tox), Number(toy), doCommand);
                        break;
                    case 'H':
                        // absolute horizontal line
                        tox = Number(cmd.x);
                        bc.lineTo(Number(tox), Number(toy), doCommand);
                        break;
                    case 'h':
                        // relative horizontal line
                        tox += Number(cmd.x);
                        bc.lineTo(Number(tox), Number(toy), doCommand);
                        break;
                    case 'V':
                        // absolute vertical line
                        toy = Number(cmd.y);
                        bc.lineTo(Number(tox), Number(toy), doCommand);
                        break;
                    case 'v':
                        // relative vertical line
                        toy += Number(cmd.y);
                        bc.lineTo(Number(tox), Number(toy), doCommand);
                        break;
                    case 'C':
                        // absolute cubic bezier curve
                        bc.drawCubicBezier(
                            // [{x:tox,y:toy}, {x:cmd.x1,y:cmd.y1}, {x:cmd.x2,y:cmd.y2}, {x:cmd.x,y:cmd.y}],
                            // 0.01,
                            [[tox, toy], [cmd.x1, cmd.y1], [cmd.x2, cmd.y2], [cmd.x, cmd.y]],
                            1,
                            doCommand
                        );
                        break;
                    case 'c':
                        // relative cubic bezier curve
                        bc.drawCubicBezier(
                            // [{x:tox,y:toy}, {x:tox+cmd.x1,y:toy+cmd.y1}, {x:tox+cmd.x2,y:toy+cmd.y2}, {x:tox+cmd.x,y:toy+cmd.y}],
                            // 0.01,
                            [[tox, toy], [tox + cmd.x1, toy + cmd.y1], [tox + cmd.x2, toy + cmd.y2], [tox + cmd.x, toy + cmd.y]],
                            1,
                            doCommand
                        );
                        break;
                    case 'S':
                        // absolute smooth cubic bezier curve

                        // check to see if previous command was a C or S
                        // if not, the inferred control point is assumed to be equal to the start curve's start point
                        var inf
                        if (prevCmd.command.indexOf('curveto') < 0) {
                            inf = {
                                x: tox,
                                y: toy
                            }
                        } else {
                            // get absolute x2 and y2 values from previous command if previous command was relative
                            if (prevCmd.relative) {
                                prevCmd.x2 = bc.pos.x - prevCmd.x + prevCmd.x2;
                                prevCmd.y2 = bc.pos.y - prevCmd.y + prevCmd.y2;
                            }
                            // calculate inferred control point from previous commands
                            // reflection of x2,y2 of previous commands
                            inf = {
                                x: tox + (tox - prevCmd.x2),// make prevCmd.x2 and y2 values absolute, not relative for calculation
                                y: toy + (toy - prevCmd.y2)
                            }
                        }

                        // draw it!
                        let pts = [[tox, toy], [inf.x, inf.y], [cmd.x2, cmd.y2], [cmd.x, cmd.y]];
                        console.log('calculated points:', pts);
                        bc.drawCubicBezier(
                            pts,
                            1,
                            doCommand
                        );

                        break;
                    case 's':
                        // relative smooth cubic bezier curve

                        // check to see if previous command was a C or S
                        // if not, the inferred control point is assumed to be equal to the start curve's start point
                        var inf
                        if (prevCmd.command.indexOf('curveto') < 0) {
                            inf = {
                                x: tox,
                                y: toy
                            }
                        } else {
                            // get absolute x2 and y2 values from previous command if previous command was relative
                            if (prevCmd.relative) {
                                prevCmd.x2 = bc.pos.x - prevCmd.x + prevCmd.x2;
                                prevCmd.y2 = bc.pos.y - prevCmd.y + prevCmd.y2;
                            }
                            // calculate inferred control point from previous commands
                            // reflection of x2,y2 of previous commands
                            inf = {
                                x: tox + (tox - prevCmd.x2),
                                y: toy + (toy - prevCmd.y2)
                            }
                        }

                        // draw it!
                        bc.drawCubicBezier(
                            [[tox, toy], [inf.x, inf.y], [tox + cmd.x2, toy + cmd.y2], [tox + cmd.x, toy + cmd.y]],
                            1,
                            doCommand
                        );
                        break;
                    case 'Q':
                        // absolute quadratic bezier curve
                        bc.drawQuadraticBezier(
                            [[tox, toy], [cmd.x1, cmd.y1], [cmd.x, cmd.y]],
                            1,
                            doCommand
                        );
                        break;
                    case 'q':
                        // relative quadratic bezier curve
                        bc.drawQuadraticBezier(
                            [[tox, toy], [tox + cmd.x1, toy + cmd.y1], [tox + cmd.x, toy + cmd.y]],
                            1,
                            doCommand
                        );
                        break;

                    case 'T':
                        // absolute smooth quadratic bezier curve

                        // check to see if previous command was a C or S
                        // if not, the inferred control point is assumed to be equal to the start curve's start point
                        var inf
                        if (prevCmd.command.indexOf('curveto') < 0) {
                            inf = {
                                x: tox,
                                y: toy
                            }
                        } else {
                            // get absolute x1 and y1 values from previous command if previous command was relative
                            if (prevCmd.relative) {
                                prevCmd.x1 = bc.pos.x - prevCmd.x + prevCmd.x1;
                                prevCmd.y1 = bc.pos.y - prevCmd.y + prevCmd.y1;
                            }
                            // calculate inferred control point from previous commands
                            // reflection of x1,y1 of previous commands
                            inf = {
                                x: tox + (tox - prevCmd.x1),
                                y: toy + (toy - prevCmd.y1)
                            }
                        }

                        // draw it!
                        bc.drawQuadraticBezier(
                            [[tox, toy], [inf.x, inf.y], [cmd.x, cmd.y]],
                            1,
                            doCommand
                        );

                        break;
                    case 't':
                        // relative smooth quadratic bezier curve

                        // check to see if previous command was a C or S
                        // if not, the inferred control point is assumed to be equal to the start curve's start point
                        var inf
                        if (prevCmd.command.indexOf('curveto') < 0) {
                            inf = {
                                x: tox,
                                y: toy
                            }
                        } else {
                            // get absolute x1 and y1 values from previous command if previous command was relative
                            if (prevCmd.relative) {
                                prevCmd.x1 = bc.pos.x - prevCmd.x + prevCmd.x1;
                                prevCmd.y1 = bc.pos.y - prevCmd.y + prevCmd.y1;
                            }
                            // calculate inferred control point from previous commands
                            // reflection of x2,y2 of previous commands
                            inf = {
                                x: tox + (tox - prevCmd.x1),
                                y: toy + (toy - prevCmd.y1)
                            }
                        }

                        // draw it!
                        bc.drawQuadraticBezier(
                            [[tox, toy], [inf.x, inf.y], [tox + cmd.x, toy + cmd.y]],
                            1,
                            doCommand
                        );
                        break;

                    case 'A':
                        // absolute arc

                        // convert arc to cubic bezier curves
                        let curves = arcToBezier({
                            px: tox,
                            py: toy,
                            cx: cmd.x,
                            cy: cmd.y,
                            rx: cmd.rx,
                            ry: cmd.ry,
                            xAxisRotation: cmd.xAxisRotation,
                            largeArcFlag: cmd.largeArc,
                            sweepFlag: cmd.sweep
                        });
                        console.log(curves);

                        // draw the arc
                        bc.drawArc(curves, doCommand);

                        break;

                    case 'a':
                        // relative arc TODO: CHECK THIS!

                        // convert arc to cubic bezier curves
                        var curves = arcToBezier({
                            px: tox,
                            py: toy,
                            cx: tox + cmd.x,// relative
                            cy: toy + cmd.y,// relative
                            rx: cmd.rx,
                            ry: cmd.ry,
                            xAxisRotation: cmd.xAxisRotation,
                            largeArcFlag: cmd.largeArc,
                            sweepFlag: cmd.sweep
                        });
                        console.log(curves);

                        // draw the arc
                        bc.drawArc(curves, doCommand);

                        break;

                    case 'Z':
                    case 'z':
                        // STOP
                        doCommand();
                        break;
                }

                prevCmd = cmd

            } else {
                cmdCount = 0;
                cmdIndex = 0;
                console.log('path done!');
                bc.drawingPath = false;
                bc.drawNextPath()
            }
        }

        doCommand()
    };

    bc.drawArc = (curves, callback) => {
        let n = 0;
        let cCount = curves.length;

        function doCommand() {
            if (n < cCount) {
                let crv = curves[n];
                // draw the cubic bezier curve created from arc input
                bc.drawCubicBezier(
                    [[bc.pos.x, bc.pos.y], [crv.x1, crv.y1], [crv.x2, crv.y2], [crv.x, crv.y]],
                    1,
                    doCommand
                );
                n++
            } else {
                if (callback !== undefined) callback()
            }
        }

        doCommand()
    };

    /// NEW WAY (adaptive, per https://www.npmjs.com/package/adaptive-bezier-curve)
    // TODO: combine cubic/quadratic versions into one with a parameter
    bc.drawCubicBezier = (points, scale = 1, callback) => {
        let n = 0;// curret bezier step in iteration
        let pts = cBezier(points[0], points[1], points[2], points[3], scale);
        let ptCount = pts.length;

        function doCommand() {
            if (n < ptCount) {
                let pt = pts[n];
                bc.lineTo(Number(pt[0]), Number(pt[1]), doCommand);
                n++
            } else {
                // console.log('bezier done!')
                if (callback !== undefined) callback();
            }
        }

        doCommand()
    };
    bc.drawQuadraticBezier = (points, scale = 1, callback) => {
        let n = 0;// curret bezier step in iteration
        let pts = qBezier(points[0], points[1], points[2], scale);
        let ptCount = pts.length;

        function doCommand() {
            if (n < ptCount) {
                let pt = pts[n];
                bc.lineTo(Number(pt[0]), Number(pt[1]), doCommand);
                n++
            } else {
                // console.log('bezier done!')
                if (callback !== undefined) callback()
            }
        }

        doCommand()
    };

    bc.drawCircle = (x, y, r, callback) => {
        // http://jsfiddle.net/heygrady/X5fw4/
        // Calculate a point on a circle
        function circle(t, radius) {
            let r = radius || 100,
                arc = Math.PI * 2;

            // calculate current angle
            let alpha = t * arc;

            // calculate current coords
            let x = Math.sin(alpha) * r,
                y = Math.cos(alpha) * r;

            // return coords
            return [x, y * -1]
        }

        let n = 0; //current step
        let pi = 3.1415926;
        let C = 2 * pi * r;
        let seg = C;

        function doCommand() {
            if (n <= seg) {
                let t = n / seg;
                let p = circle(t, r);
                if (n === 0) {
                    bc.moveTo(x + p[0], y + p[1], doCommand);
                } else {
                    bc.lineTo(x + p[0], y + p[1], doCommand);
                }
                n++
            } else {
                if (callback !== undefined) callback()
            }
        }

        doCommand()
    };
    bc.drawCircles = (o) => {
        console.log(o.count);
        let count = o.count;
        let n = 0;

        function doCommand() {
            if (n < count) {
                bc.drawCircle(o.x[n], o.y[n], o.r[n], doCommand);
                console.log(n / count);
                n++
            } else {
                console.log('done with circles!')
            }
        }

        doCommand()
    };

    return bc
};
module.exports = BotController;

console.log("   ,--.                      ,--.          ,--.  \n ,-|  ,--.--.,--,--,--.   ,--|  |-. ,---.,-'  '-. \n' .-. |  .--' ,-.  |  |.'.|  | .-. | .-. '-.  .-' \n\\ `-' |  |  \\ '-'  |   .'.   | `-' ' '-' ' |  |   \n `---'`--'   `--`--'--'   '--'`---' `---'  `--'  ");
