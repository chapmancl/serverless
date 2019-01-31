'use strict';

const BbPromise = require('bluebird');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

class AwsCompileServiceCatalog {
  constructor(serverless, options) {        
    this.serverless = serverless;
    this.options = options;
    const servicePath = this.serverless.config.servicePath || '';
    this.packagePath = this.serverless.service.package.path ||
      path.join(servicePath || '.', '.serverless');
    this.provider = this.serverless.getProvider('aws');      
        
        
    // key off the ServiceCatalog Product ID
    if ('scProductId' in this.serverless.service.provider) {
        this.newFunction = this.cfProvisionedProductTemplate();    
        this.hooks = {
          'package:compileFunctions': () => BbPromise.bind(this)
            .then(this.compileFunctions)
        };    
        console.log("AwsCompileServiceCatalog");
        // clear out any other aws plugins
        this.serverless.pluginManager.hooks['package:compileEvents'].length = 0;
        this.serverless.pluginManager.hooks['package:compileFunctions'].length = 0;
        this.serverless.pluginManager.hooks['package:setupProviderConfiguration'].length = 0;    
    }    
  }

  compileFunctions() {
    const allFunctions = this.serverless.service.getAllFunctions();
    return BbPromise.each(
      allFunctions,
      functionName => this.compileFunction(functionName)
    );
  }
  
  compileFunction(functionName) {    
    const functionObject = this.serverless.service.getFunction(functionName);
    functionObject.package = functionObject.package || {};

    const serviceArtifactFileName = this.provider.naming.getServiceArtifactName();
    const functionArtifactFileName = this.provider.naming.getFunctionArtifactName(functionName);
    const functionLogicalId = this.provider.naming.getSCProvisionLogicalId(functionName);        
    
    let artifactFilePath = functionObject.package.artifact ||
      this.serverless.service.package.artifact;
    if (!artifactFilePath ||
      (this.serverless.service.artifact && !functionObject.package.artifact)) {
      let artifactFileName = serviceArtifactFileName;
      if (this.serverless.service.package.individually || functionObject.package.individually) {
        artifactFileName = functionArtifactFileName;
      }

      artifactFilePath = path.join(this.serverless.config.servicePath
        , '.serverless', artifactFileName);
    }

    if (this.serverless.service.package.deploymentBucket) {
      this.setProvisioningParamValue("BucketName", this.serverless.service.package.deploymentBucket );
    } else {
      const errorMessage = 
        'Missing provider.deploymentBucket parameter.' +
        ' Please make sure you provide a deployment bucket parameter. SC Provisioned Product cannot create an S3 Bucket.' +
        ' Please check the docs for more info'
        ;
      return BbPromise.reject(new this.serverless.classes.Error(errorMessage));
    }

    const s3Folder = this.serverless.service.package.artifactDirectoryName;
    const s3FileName = artifactFilePath.split(path.sep).pop();    
    this.setProvisioningParamValue("BucketKey", `${s3Folder}/${s3FileName}` );
        
    if (!functionObject.handler) {
      const errorMessage = 
        `Missing "handler" property in function "${functionName}".` +
        ' Please make sure you point to the correct lambda handler.' +
        ' For example: handler.hello.' +
        ' Please check the docs for more info'
        ;
      return BbPromise.reject(new this.serverless.classes.Error(errorMessage));
    }

    const MemorySize = Number(functionObject.memorySize)
      || Number(this.serverless.service.provider.memorySize)
      || 1024;
    const Timeout = Number(functionObject.timeout)
      || Number(this.serverless.service.provider.timeout)
      || 6;
    const Runtime = functionObject.runtime
      || this.serverless.service.provider.runtime
      || 'nodejs4.3';

    this.setProvisioningParamValue("FunctionHandler", functionObject.handler );
    this.setProvisioningParamValue("FunctionName", functionObject.name);
    this.setProvisioningParamValue("FunctionMemorySize", MemorySize);
    this.setProvisioningParamValue("FunctionTimeout", Timeout);
    this.setProvisioningParamValue("FunctionRuntime", Runtime);
    this.setProvisioningParamValue("FunctionStage", this.provider.getStage());
    this.newFunction.Properties.ProvisioningArtifactName = this.serverless.service.provider.scProductVersion;
    this.newFunction.Properties.ProductId = this.serverless.service.provider.scProductId;
    this.newFunction.Properties.ProvisionedProductName = `provisionSC-${functionObject.name}`;
    
    // publish these properties to the platform
    this.serverless.service.functions[functionName].memory = MemorySize;
    this.serverless.service.functions[functionName].timeout = Timeout;
    this.serverless.service.functions[functionName].runtime = Runtime;

    if (functionObject.tags || this.serverless.service.provider.tags) {
      const tags = Object.assign(
        {},
        this.serverless.service.provider.tags,
        functionObject.tags
      );
      this.newFunction.Properties.Tags = 
        Object.keys(tags).map((key) => { 
          return { Key:key, Value:tags[key] };        
        });      
    }

    
    // check the current state
    let isFirstDeploy = true;
    let isNewVersion = true;
    let currentVersionHash = "";    
    const currStack = this.getStackOutput("LambdaVersionHash")
    .then((lhash) => {
      console.log(lhash);    
        if (lhash) {
          console.log("Stack exists, not the first deploy!");
          isFirstDeploy = false;
          currentVersionHash = lhash;
        } else {
          // check the update output parameter
          const currStack = this.getStackOutput("LambdaVersionHashUpdate")
            .then((uhash) => {
              if (uhash) {
                console.log("Stack exists, not the first deploy!");
                isFirstDeploy = false;
              } else {
                console.log("Stack does not exist, first deploy!");
              }
            });
        }            
    })
    .then(() => {
        
    const fileHash = crypto.createHash('sha256');
    fileHash.setEncoding('base64');
    
    return BbPromise.fromCallback(cb => {
      const readStream = fs.createReadStream(artifactFilePath);
      readStream.on('data', chunk => {
        fileHash.write(chunk);
      })
      .on('end', cb)
      .on('error', cb);
    })
    .then(() => {
        // Finalize hashes
        fileHash.end();
        const fileDigest = fileHash.read();          
        let outputhashname = "LambdaVersionHash";
        // check if the version hash has changed
        // We have to toggle between the version blocks in the template because CF cannot update a lambda version.
        console.log(`check file hash: ${fileDigest}==${currentVersionHash}`);
        if (fileDigest == currentVersionHash) {
          console.log("file hash is the same!");
          this.setProvisioningParamValue("LambdaVersionSHA256", "" );
          this.setProvisioningParamValue("LambdaVersionSHA256update","");
          outputhashname = null;
        } else {
          if (isFirstDeploy | currentVersionHash == "") {
            // first deploy, or the value is not in the LambdaVersionSHA256
            console.log("first deploy, or the value is not in the LambdaVersionSHA256");
            this.setProvisioningParamValue("LambdaVersionSHA256",fileDigest );
            this.setProvisioningParamValue("LambdaVersionSHA256update","");
          } else {
            // not first deploy and the value is currently in LambdaVersionSHA256.  toggle to the update
            console.log("not first deploy and the value is currently in LambdaVersionSHA256.  toggle to the update");
            this.setProvisioningParamValue("LambdaVersionSHA256", "" );
            this.setProvisioningParamValue("LambdaVersionSHA256update",fileDigest);
            outputhashname = "LambdaVersionHashUpdate";            
          }
        }
        
        
        this.serverless.service.provider.compiledCloudFormationTemplate.Resources[functionLogicalId] = this.newFunction;
        this.serverless.service.provider.compiledCloudFormationTemplate.Outputs.ProvisionedProductID = {
          Description: 'Provisioned product ID',
          Value: { Ref: functionLogicalId }
        };
        this.serverless.service.provider.compiledCloudFormationTemplate.Outputs.ProductCloudformationStackArn = {
          Description: 'The Arn of the created Service Catalog product CloudFormation Stack',
          Value:{"Fn::GetAtt": [functionLogicalId, "CloudformationStackArn"] }
        };
        if (outputhashname) {
          this.serverless.service.provider.compiledCloudFormationTemplate.Outputs[outputhashname] = {
            Description: 'SHA256 hash of the latest lambda version',
            Value:fileDigest
          };
        }
        
        // don't do this the first time
        if (!isFirstDeploy) {
          this.serverless.service.provider.compiledCloudFormationTemplate.Outputs.ServiceEndpoint = {
            Description: 'URL of the service endpoint',
            Value:{"Fn::ImportValue" : `${functionObject.name}-ServiceEndpoint` }
          };         
        }        
                     
        return BbPromise.resolve();
        
    });
    });
  }

  cfProvisionedProductTemplate() {
    return {        
      Type : "AWS::ServiceCatalog::CloudFormationProvisionedProduct",
      Properties : {
        ProvisioningParameters : [ 
          {Key:"BucketName"         , Value: 'ServerlessDeploymentBucket' },
          {Key:"BucketKey"          , Value: 'S3Key'       },
          {Key:"FunctionName"       , Value: 'FunctionName'},
          {Key:"FunctionStage"      , Value: 'test'        },
          {Key:"FunctionHandler"    , Value: 'Handler'     },
          {Key:"FunctionRuntime"    , Value: 'Runtime'     },
          {Key:"FunctionMemorySize" , Value: 'MemorySize'  },
          {Key:"FunctionTimeout"    , Value: 'Timeout'     }, 
          {Key:"LambdaVersionSHA256", Value: ''  },
          {Key:"LambdaVersionSHA256update", Value: ''  }      
          
        ],
        ProvisioningArtifactName : 'ProvisioningArtifactName',
        ProductId : 'ProductId',
        ProvisionedProductName : {"Fn::Sub":"provisionServerless-${FunctionName}"}
      }
    };
  }

  getStackOutput(outputkey) {
    return this.provider.request('CloudFormation',
      'describeStacks',
      {
        StackName: this.provider.naming.getStackName()
      }
    ).then((result) => {
        let ovalue = null;
        if (result.Stacks.length > 0 ) {
            for (let ov of result.Stacks[0].Outputs) {
                if (ov.OutputKey == outputkey) {
                    ovalue = ov.OutputValue;
                    break;
                }
            }
        }
        return ovalue;
    })
    .catch((err) => {
        return null;
    })
    ;
  }
  
  getProvisioningParamValue(key, array) {
      let found = false;
      let value = null;
      for (let kv of array) {
          if (kv.Key === key) {
              value = kv.Value;
              found = true;
              break;
          }         
      }      
      if (!found) {
          console.error(`object with Key=${key} not found in array!`);
      }
      return value;
  }
  
  setProvisioningParamValue(key, value) {
      let found = false;
      for (let kv of this.newFunction.Properties.ProvisioningParameters) {
          if (kv.Key === key) {
              kv.Value = value;
              found = true;
              break;
          }         
      }      
      if (!found) {
          console.error(`object with Key=${key} not found in ProvisioningParameters!`);
      }
      return found;
  }

}

module.exports = AwsCompileServiceCatalog;
